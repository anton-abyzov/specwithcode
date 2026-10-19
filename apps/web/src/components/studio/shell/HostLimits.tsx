/**
 * Subscription limits per machine: one block per connected host with a row
 * for each provider signed in there. The project's own host comes first;
 * offline hosts show what they last reported and when. Opening it never asks
 * a provider for anything: it reads the snapshots each host already holds.
 */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@specweave-studio/contracts";
import { formatDuration } from "@specweave-studio/shared/usageLimits";
import { LinkIcon, MonitorIcon, TicketIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { environmentPresentations } from "../../../state/presentation";
import {
  bindingWindowId,
  collectHostLimitBlocks,
  formatAgo,
  savableReadings,
  usageToneOf,
  windowDisplayLabel,
  type HostLimitBlock,
  type HostLimitWindow,
  type HostProviderRow,
} from "../../../studio/hostLimitsModel";
import { blockedLabel, leftPercent, usageLeftLabel } from "../../../studio/usageIndicatorModel";
import { loadSavedHostReadings, saveHostReadings } from "../../../studio/hostLimitsStorage";
import { ProviderInstanceIcon } from "../../chat/ProviderInstanceIcon";
import { getDriverOption } from "../../settings/providerDriverMeta";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../ui/select";
import { Tip } from "./Tip";
import "./host-limits.css";

const driverLabel = (driver: HostProviderRow["driver"]) =>
  getDriverOption(driver)?.label ?? String(driver);

/**
 * Every connected host's blocks as of `now`, or only the hosts in `only`;
 * online readings are saved for later.
 */
export function useHostLimitBlocks(
  projectEnvironmentId: EnvironmentId | null,
  now: number,
  only: ReadonlySet<EnvironmentId> | null = null,
) {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  // Read once: saving below must not feed back into the blocks it came from.
  const [saved] = useState(() => loadSavedHostReadings(Date.now()));
  const blocks = useMemo(
    () =>
      collectHostLimitBlocks(
        only === null ? presentations : new Map([...presentations].filter(([id]) => only.has(id))),
        { projectEnvironmentId, saved, driverLabel, now },
      ),
    [presentations, projectEnvironmentId, saved, now, only],
  );
  useEffect(() => {
    const at = Date.now();
    saveHostReadings(savableReadings(blocks, at), at);
  }, [blocks]);
  return blocks;
}

function statusText(block: HostLimitBlock, now: number): string {
  const read = block.readAt === null ? null : formatAgo(block.readAt, now);
  if (block.status === "online") return read ? `Online · read ${read}` : "Online";
  if (block.status === "connecting") return read ? `Connecting · last read ${read}` : "Connecting";
  return read ? `Offline · last read ${read}` : "Offline · no saved reading";
}

function ProviderIcon({ row, size }: { row: HostProviderRow; size: "sm" | "md" }) {
  const cls = size === "sm" ? "size-3.5" : "size-4";
  return (
    <ProviderInstanceIcon
      driverKind={row.driver}
      displayName={row.label}
      acpRegistryIconUrl={row.iconUrl}
      showBadge={false}
      className={cls}
      iconClassName={`${cls} text-foreground/80`}
    />
  );
}

function ProviderRow({ row, now, dim }: { row: HostProviderRow; now: number; dim: boolean }) {
  const binding = bindingWindowId(row.windows);
  return (
    <li className="sws-hl-provider" data-dim={dim || undefined}>
      <div className="sws-hl-provider-name">
        <ProviderIcon row={row} size="md" />
        <div>
          <strong>{row.label}</strong>
          <span className="sws-hl-identity">
            {[row.identity, row.plan].filter(Boolean).join(" · ") || "Account not reported"}
          </span>
          {row.sharedWith.length > 0 ? (
            <span
              className="sws-hl-shared"
              title="The same account is signed in on these hosts; they share one quota."
            >
              <LinkIcon aria-hidden />
              <span className="truncate">Same account on {row.sharedWith.join(", ")}</span>
            </span>
          ) : null}
        </div>
      </div>
      <div className="sws-hl-windows">
        {row.notice !== null ? (
          <span className="sws-hl-notice">{row.notice}</span>
        ) : (
          row.windows.map((window) => (
            <div
              key={`${window.kind}:${window.id}`}
              className="sws-hl-window"
              data-blocked={window.blockedBy ? "" : undefined}
              data-binding={
                row.windows.length > 1 && `${window.kind}:${window.id}` === binding ? "" : undefined
              }
            >
              <span className="sws-hl-window-label">
                {windowDisplayLabel(window)}
                {row.windows.length > 1 && `${window.kind}:${window.id}` === binding ? (
                  <span className="sr-only">, runs out first</span>
                ) : null}
              </span>
              <span
                className="sws-hl-bar"
                data-tone={
                  window.stale || window.blockedBy ? "stale" : usageToneOf(window.usedPercent)
                }
                aria-hidden
              >
                <span style={{ width: `${leftPercent(window.usedPercent)}%` }} />
              </span>
              {window.blockedBy ? (
                <span className="sws-hl-window-blocked">{blockedLabel(window.blockedBy, now)}</span>
              ) : (
                <>
                  <span
                    className="sws-hl-window-value"
                    data-tone={window.stale ? undefined : usageToneOf(window.usedPercent)}
                  >
                    {window.stale ? "reset since" : usageLeftLabel(window.usedPercent)}
                  </span>
                  <span className="sws-hl-window-reset">
                    {window.resetsAt === null
                      ? ""
                      : `resets in ${formatDuration(window.resetsAt - now)}`}
                  </span>
                </>
              )}
            </div>
          ))
        )}
        {row.bankedResets > 0 ? (
          <span className="sws-hl-banked">
            <TicketIcon aria-hidden />
            {row.bankedResets} {row.bankedResets === 1 ? "reset" : "resets"} banked
          </span>
        ) : null}
      </div>
    </li>
  );
}

/** Which machine the viewer is on, and which one runs the open project. */
function HostBadges({ block }: { block: HostLimitBlock }) {
  return (
    <>
      {block.isThisMachine ? <span className="sws-hl-badge">This machine</span> : null}
      {block.isProjectHost ? (
        <Tip label="This project's coordinator runs on this machine." side="top">
          <span className="sws-hl-badge">This project</span>
        </Tip>
      ) : null}
    </>
  );
}

function HostBlock({ block, now }: { block: HostLimitBlock; now: number }) {
  return (
    <section
      className="sws-hl-block"
      data-status={block.status}
      aria-label={`${block.label} subscription limits`}
    >
      <header>
        <MonitorIcon aria-hidden className="sws-hl-icon" />
        <strong>{block.label}</strong>
        <HostBadges block={block} />
        <span className="sws-hl-status">
          <span className="sws-hl-dot" aria-hidden />
          {statusText(block, now)}
        </span>
      </header>
      {block.providers.length === 0 ? (
        <p className="sws-hl-empty">
          {block.status === "online"
            ? "No provider is signed in on this host."
            : "This host has not reported limits to this window yet."}
        </p>
      ) : (
        <ul>
          {block.providers.map((row) => (
            <ProviderRow key={row.key} row={row} now={now} dim={block.status !== "online"} />
          ))}
        </ul>
      )}
    </section>
  );
}

type View = "machines" | "pooled" | `host:${string}`;

/**
 * The settings section: a grouped dropdown picks all machines, one machine,
 * or the pooled view (rendered by `pooled`), and the blocks follow.
 */
export function HostLimits({
  projectEnvironmentId,
  pooled,
}: {
  projectEnvironmentId: EnvironmentId | null;
  pooled: React.ReactNode;
}) {
  const [now, setNow] = useState(Date.now);
  const [view, setView] = useState<View>("machines");
  const blocks = useHostLimitBlocks(projectEnvironmentId, now);
  const items = [
    { value: "machines", label: "All machines" },
    { value: "pooled", label: "Pooled across machines" },
    ...blocks.map((block) => ({ value: `host:${block.environmentId}`, label: block.label })),
  ];
  const shown =
    view === "machines" ? blocks : blocks.filter((block) => `host:${block.environmentId}` === view);
  return (
    <div className="sws-hl-limits">
      <div className="sws-hl-toolbar">
        <Select
          items={items}
          value={view}
          onValueChange={(value) => {
            if (value !== null) setView(value as View);
          }}
        >
          <SelectTrigger size="xs" className="w-52" aria-label="Show limits for">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup align="start" alignItemWithTrigger={false}>
            <SelectGroup>
              <SelectGroupLabel>Layout</SelectGroupLabel>
              <SelectItem value="machines">All machines</SelectItem>
              <SelectItem value="pooled">Pooled across machines</SelectItem>
            </SelectGroup>
            {blocks.length > 0 ? (
              <SelectGroup>
                <SelectGroupLabel>Machine</SelectGroupLabel>
                {blocks.map((block) => (
                  <SelectItem key={block.environmentId} value={`host:${block.environmentId}`}>
                    {block.label}
                    {block.isThisMachine ? " (this machine)" : ""}
                    {block.isProjectHost ? " (this project)" : ""}
                  </SelectItem>
                ))}
              </SelectGroup>
            ) : null}
          </SelectPopup>
        </Select>
        <button type="button" className="sws-hl-link" onClick={() => setNow(Date.now())}>
          Update reset countdowns
        </button>
      </div>
      {view === "pooled" ? (
        pooled
      ) : shown.length === 0 ? (
        <p className="project-muted">No host is connected yet.</p>
      ) : (
        shown.map((block) => <HostBlock key={block.environmentId} block={block} now={now} />)
      )}
    </div>
  );
}

/**
 * Usage → Limits by machine: one block per selected host with every provider
 * signed in there, its account and each window. `now` comes from the page,
 * which advances it on refresh.
 */
export function MachineLimitBlocks({
  only,
  now,
}: {
  only: ReadonlySet<EnvironmentId> | null;
  now: number;
}) {
  const blocks = useHostLimitBlocks(null, now, only);
  return <MachineLimitBlocksView blocks={blocks} now={now} />;
}

export function MachineLimitBlocksView({
  blocks,
  now,
}: {
  blocks: readonly HostLimitBlock[];
  now: number;
}) {
  if (blocks.length === 0) {
    return <p className="text-sm text-muted-foreground">No host is connected yet.</p>;
  }
  return (
    <div className="sws-hl-limits">
      {blocks.map((block) => (
        <HostBlock key={block.environmentId} block={block} now={now} />
      ))}
    </div>
  );
}

function compactStatus(block: HostLimitBlock, now: number): string {
  if (block.status === "online") return "Online";
  if (block.status === "connecting") return "Connecting";
  return block.readAt === null ? "Offline" : `Offline · ${formatAgo(block.readAt, now)}`;
}

/** Who is signed in, and the other machines sharing that account's quota. */
function accountLine(row: HostProviderRow): string {
  const who = row.identity ?? "Account not reported";
  return row.sharedWith.length > 0 ? `${who} · also on ${row.sharedWith.join(", ")}` : who;
}

/**
 * One window of a provider: its name, what is left and when it resets. With
 * several windows, the one that stops the provider first keeps full contrast
 * and the others recede; a warning or spent tone always shows. A blocked row
 * names its blocker, whose own row shows the reset.
 */
function CompactWindowRow({
  window,
  now,
  rank,
}: {
  window: HostLimitWindow;
  now: number;
  rank: "binding" | "other" | null;
}) {
  const tone = window.stale || window.blockedBy ? "stale" : usageToneOf(window.usedPercent);
  const label = windowDisplayLabel(window);
  return (
    <div className="sws-hl-compact-window" data-tone={tone} data-rank={rank ?? undefined}>
      <span className="sws-hl-compact-window-label">
        {label}
        {rank === "binding" ? <span className="sr-only">, runs out first</span> : null}
      </span>
      <span className="sws-hl-bar" data-tone={tone} aria-hidden>
        <span style={{ width: `${leftPercent(window.usedPercent)}%` }} />
      </span>
      {window.blockedBy ? (
        <>
          <Tip label={blockedLabel(window.blockedBy, now)} side="left">
            <span className="sws-hl-compact-value">Blocked</span>
          </Tip>
          <span className="sws-hl-compact-aside">
            by {window.blockedBy.label}
            {window.blockedBy.resetsAt !== null && window.blockedBy.resetsAt > now ? (
              <span className="sr-only">
                {`, usable again in ${formatDuration(window.blockedBy.resetsAt - now)}`}
              </span>
            ) : null}
          </span>
        </>
      ) : (
        <>
          <span className="sws-hl-compact-value">
            {window.stale ? "reset since" : usageLeftLabel(window.usedPercent)}
          </span>
          <span className="sws-hl-compact-aside">
            {window.resetsAt === null ? "" : `in ${formatDuration(window.resetsAt - now)}`}
          </span>
        </>
      )}
    </div>
  );
}

/**
 * A provider on a host: its name and account on one line, then every window
 * it reports on aligned rows, so a 5-hour and a weekly limit read side by side
 * and the one that binds stands out. The coordinator's account adds its plan.
 */
function CompactProviderEntry({
  row,
  now,
  coordinator,
}: {
  row: HostProviderRow;
  now: number;
  coordinator: boolean;
}) {
  const binding = row.windows.length > 1 ? bindingWindowId(row.windows) : null;
  const account = [accountLine(row), coordinator ? row.plan : null].filter(Boolean).join(" · ");
  return (
    <li
      className="sws-hl-compact-entry"
      data-tone={usageToneOf(row.peak)}
      data-coordinator={coordinator || undefined}
    >
      <div className="sws-hl-compact-row">
        <ProviderIcon row={row} size="sm" />
        <span className="sws-hl-compact-provider" data-wide="">
          <span className="sws-hl-compact-name">{row.label}</span>
          {coordinator ? <span className="sws-hl-tag">Coordinator</span> : null}
          <Tip label={account} side="left">
            <span className="sws-hl-compact-account">{account}</span>
          </Tip>
        </span>
      </div>
      {row.windows.map((window) => {
        const key = `${window.kind}:${window.id}`;
        return (
          <CompactWindowRow
            key={key}
            window={window}
            now={now}
            rank={binding === null ? null : key === binding ? "binding" : "other"}
          />
        );
      })}
      {row.notice !== null ? <span className="sws-hl-compact-account">{row.notice}</span> : null}
      {row.bankedResets > 0 ? (
        <span className="sws-hl-compact-account sws-hl-banked">
          <TicketIcon aria-hidden />
          {row.bankedResets} {row.bankedResets === 1 ? "reset" : "resets"} banked
        </span>
      ) : null}
    </li>
  );
}

/**
 * All hosts at a glance for the usage chip's popover. One grid shared by
 * every host (subgrid), so icons, bars, values and resets line up across
 * machines: a header per host, then each provider with its account.
 */
export function HostLimitsCompact({
  projectEnvironmentId,
  coordinatorInstanceId = null,
  now,
}: {
  projectEnvironmentId: EnvironmentId | null;
  coordinatorInstanceId?: string | null;
  now: number;
}) {
  const blocks = useHostLimitBlocks(projectEnvironmentId, now);
  return (
    <HostLimitsCompactView
      blocks={blocks}
      now={now}
      coordinator={
        projectEnvironmentId && coordinatorInstanceId
          ? { environmentId: projectEnvironmentId, instanceId: coordinatorInstanceId }
          : null
      }
    />
  );
}

export function HostLimitsCompactView({
  blocks,
  now,
  coordinator = null,
}: {
  blocks: readonly HostLimitBlock[];
  now: number;
  /** The host and instance this project's coordinator runs on: shown in full. */
  coordinator?: { environmentId: EnvironmentId; instanceId: string } | null;
}) {
  if (blocks.length === 0) return null;
  const isCoordinator = (block: HostLimitBlock, row: HostProviderRow) =>
    coordinator !== null &&
    block.environmentId === coordinator.environmentId &&
    row.instanceId === coordinator.instanceId;
  return (
    <section className="sws-hl-compact" aria-label="Limits by machine">
      <ul className="sws-hl-compact-grid">
        {blocks.map((block) => {
          const rows = block.providers.filter(
            (row) => row.notice === null || isCoordinator(block, row),
          );
          return (
            <li
              key={block.environmentId}
              className="sws-hl-compact-host"
              data-status={block.status}
            >
              <div className="sws-hl-compact-head">
                <span className="sws-hl-dot" aria-hidden />
                <span className="sws-hl-compact-title">
                  <Tip label={block.label} side="top">
                    <strong>{block.label}</strong>
                  </Tip>
                  <HostBadges block={block} />
                  <span className="sws-hl-compact-status">{compactStatus(block, now)}</span>
                </span>
              </div>
              {rows.length === 0 ? (
                <p className="sws-hl-compact-empty">
                  {block.providers.length > 0
                    ? "No limits reported"
                    : block.status === "online"
                      ? "No providers signed in"
                      : "No saved reading"}
                </p>
              ) : (
                <ul>
                  {rows.map((row) => (
                    <CompactProviderEntry
                      key={row.key}
                      row={row}
                      now={now}
                      coordinator={isCoordinator(block, row)}
                    />
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
