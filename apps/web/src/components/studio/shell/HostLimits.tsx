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
  collectHostLimitBlocks,
  formatAgo,
  savableReadings,
  usageToneOf,
  type HostLimitBlock,
  type HostProviderRow,
} from "../../../studio/hostLimitsModel";
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
import "./host-limits.css";

const driverLabel = (driver: HostProviderRow["driver"]) =>
  getDriverOption(driver)?.label ?? String(driver);

/** Every connected host's blocks as of `now`; online readings are saved for later. */
export function useHostLimitBlocks(projectEnvironmentId: EnvironmentId | null, now: number) {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  // Read once: saving below must not feed back into the blocks it came from.
  const [saved] = useState(() => loadSavedHostReadings(Date.now()));
  const blocks = useMemo(
    () => collectHostLimitBlocks(presentations, { projectEnvironmentId, saved, driverLabel, now }),
    [presentations, projectEnvironmentId, saved, now],
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
              Same account on {row.sharedWith.join(", ")}
            </span>
          ) : null}
        </div>
      </div>
      <div className="sws-hl-windows">
        {row.notice !== null ? (
          <span className="sws-hl-notice">{row.notice}</span>
        ) : (
          row.windows.map((window) => (
            <div key={`${window.kind}:${window.id}`} className="sws-hl-window">
              <span className="sws-hl-window-label">{window.label}</span>
              <span
                className="sws-hl-bar"
                data-tone={window.stale ? "stale" : usageToneOf(window.usedPercent)}
                aria-hidden
              >
                <span style={{ width: `${window.usedPercent}%` }} />
              </span>
              <span className="sws-hl-window-value">
                {window.stale ? "reset since" : `${window.usedPercent}%`}
              </span>
              <span className="sws-hl-window-reset">
                {window.resetsAt === null
                  ? ""
                  : `resets in ${formatDuration(window.resetsAt - now)}`}
              </span>
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
        {block.isProjectHost ? <span className="sws-hl-badge">Project device</span> : null}
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
                    {block.isProjectHost ? " (project device)" : ""}
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

/** Rows with bars; the settings page explains the providers that report none. */
const limited = (block: HostLimitBlock) => block.providers.filter((row) => row.notice === null);

/**
 * All hosts at a glance for the usage chip's popover: a row per host, a
 * cell per provider with its fullest window.
 */
export function HostLimitsCompact({
  projectEnvironmentId,
  now,
}: {
  projectEnvironmentId: EnvironmentId | null;
  now: number;
}) {
  const blocks = useHostLimitBlocks(projectEnvironmentId, now);
  if (blocks.length === 0) return null;
  return (
    <section className="sws-hl-compact" aria-label="Limits by machine">
      <h3>By machine</h3>
      <ul>
        {blocks.map((block) => (
          <li key={block.environmentId} data-status={block.status}>
            <span className="sws-hl-compact-name">
              <span className="sws-hl-dot" aria-hidden />
              {block.label}
              {block.isProjectHost ? <span className="sws-hl-badge">Project</span> : null}
            </span>
            <span className="sws-hl-compact-cells">
              {limited(block).length === 0 ? (
                <span className="sws-hl-compact-muted">
                  {block.providers.length > 0
                    ? "No limits reported"
                    : block.status === "online"
                      ? "No providers"
                      : "No saved reading"}
                </span>
              ) : (
                limited(block).map((row) => (
                  <span
                    key={row.key}
                    className="sws-hl-compact-cell"
                    data-tone={usageToneOf(row.peak)}
                    title={`${row.label}${row.identity ? ` · ${row.identity}` : ""}${
                      row.sharedWith.length > 0
                        ? ` · same account on ${row.sharedWith.join(", ")}`
                        : ""
                    }`}
                  >
                    <ProviderIcon row={row} size="sm" />
                    {row.peak === null ? "–" : `${row.peak}%`}
                    {row.sharedWith.length > 0 ? <LinkIcon aria-hidden /> : null}
                  </span>
                ))
              )}
            </span>
            <span className="sws-hl-compact-muted">
              {block.status !== "online" && block.readAt !== null
                ? formatAgo(block.readAt, now)
                : ""}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
