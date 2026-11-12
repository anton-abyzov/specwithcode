/**
 * Overview's rows: one compact line per chat, project or machine. Every row is a
 * real link or button, and chat rows carry `data-overview-row` so J/K can walk them.
 */
import { useTx } from "../../i18n";
import type { ServerProvider } from "@specweave-studio/contracts";
import { PROVIDER_DISPLAY_NAMES } from "@specweave-studio/contracts";
import { Link } from "@tanstack/react-router";
import { PlusIcon, SettingsIcon } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import type { ProviderInstanceEntry } from "../../providerInstances";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { chatNavigationTarget } from "../../studio/projectPaneThreads";
import { compactThreadPlan } from "../../studio/threadPlanProgress";
import { useThreadIncrementProgress } from "../../studio/useThreadIncrementProgress";
import {
  sessionAttentionLabel,
  sessionStateSince,
  type SessionView,
} from "../../studio/overviewModel";
import { ProjectFavicon } from "../ProjectFavicon";
import { ThreadModelBadge } from "./shell/ModelBadge";
import { PlanProgressChip } from "./PlanProgressChip";

/** relativeTime from the overview model, with its words translated. */
export function relativeTimeLabel(
  tx: ReturnType<typeof useTx>,
  value: string | null | undefined,
  now: number,
): string {
  const timestamp = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(timestamp) || timestamp === 0) return tx("Time unknown");
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 1) return tx("Just now");
  if (minutes < 60) return tx("{count}m ago", { count: minutes });
  if (minutes < 1_440) return tx("{count}h ago", { count: Math.floor(minutes / 60) });
  return tx("{count}d ago", { count: Math.floor(minutes / 1_440) });
}

export function providerLabel(
  providers: readonly ServerProvider[],
  instanceId: string | null,
): string {
  if (!instanceId) return "Provider unknown";
  const provider = providers.find((candidate) => candidate.instanceId === instanceId);
  return (
    provider?.displayName ??
    (provider ? PROVIDER_DISPLAY_NAMES[provider.driver] : undefined) ??
    (PROVIDER_DISPLAY_NAMES as Record<string, string | undefined>)[instanceId] ??
    instanceId
  );
}

type ChatTarget = ReturnType<typeof chatNavigationTarget>;

/** A link to a chat: a project's thread in the project's right panel, any other full page. */
function ChatLink({
  target,
  className,
  children,
}: {
  target: ChatTarget;
  className: string;
  children: ReactNode;
}) {
  return target.to === "/projects/$projectKey" ? (
    <Link
      to={target.to}
      params={{ ...target.params }}
      search={{ ...target.search }}
      className={className}
      data-overview-row
    >
      {children}
    </Link>
  ) : (
    <Link to={target.to} params={{ ...target.params }} className={className} data-overview-row>
      {children}
    </Link>
  );
}

type Tone = "red" | "amber" | "moss" | "muted" | "plain";

function sessionTone(s: SessionView): Tone {
  if (s.attention) return s.attention === "failed" ? "red" : "amber";
  return s.working ? "moss" : s.settled ? "muted" : "plain";
}

/** One chat on one line: state dot, title, where it runs, its state and age. */
export function ChatRow({
  session: s,
  target,
  host,
  provider,
  entries,
  now,
}: {
  session: SessionView;
  target: ChatTarget;
  host: string;
  provider: string;
  entries: ReadonlyMap<string, ProviderInstanceEntry>;
  now: number;
}) {
  const tx = useTx();
  // A cached row from an older host can arrive without its model.
  const selection = s.thread.modelSelection as typeof s.thread.modelSelection | undefined;
  const tone = sessionTone(s);
  const incrementProgress = useThreadIncrementProgress({
    environmentId: s.thread.environmentId,
    projectId: s.project === null ? null : s.thread.projectId,
    threadIds: [s.thread.id],
    activityKey: s.thread.updatedAt,
  });
  const plan = compactThreadPlan(incrementProgress.get(s.thread.id) ?? null, s.thread.planProgress);
  const state = s.attention
    ? tx(s.attentionLabel ?? sessionAttentionLabel(s.attention, s.thread))
    : s.state;
  return (
    <ChatLink
      target={target}
      className={`studio-row studio-session-item${s.attention ? " studio-attention-item" : ""}`}
    >
      <span className={`studio-state-dot ${tone}`} aria-hidden="true" />
      <span className="studio-row-main">
        <span className="studio-row-title">{s.thread.title || tx("Untitled chat")}</span>
        <span className="studio-row-meta" style={{ container: "sessmeta / inline-size" }}>
          <strong className="studio-session-project">
            {s.project?.title ?? tx("Project unavailable")}
          </strong>
          <span aria-hidden="true"> · </span>
          {host}
          <span aria-hidden="true"> · </span>
          {selection ? <ThreadModelBadge thread={s.thread} entries={entries} /> : provider}
          {plan ? (
            <>
              <span aria-hidden="true"> · </span>
              <PlanProgressChip plan={plan} />
            </>
          ) : null}
        </span>
      </span>
      {/* An idle chat in Recent needs no label; the dot and the list already say so. */}
      {tone === "plain" && s.state === "Ready" ? (
        <span />
      ) : (
        <span className={`studio-pill ${tone}`}>{state}</span>
      )}
      <time className="studio-row-age" dateTime={sessionStateSince(s.thread)}>
        {relativeTimeLabel(tx, sessionStateSince(s.thread), now)}
      </time>
    </ChatLink>
  );
}

export type ProjectRowView = {
  readonly group: SidebarProjectSnapshot;
  readonly sessions: number;
  readonly attention: number;
  readonly working: number;
  readonly complete?: boolean;
};

/** A project in the rail: opens the project; its count filters Needs you to it. */
export function ProjectRow({
  card,
  hosts,
  filtered,
  canStart,
  onFilter,
  onNewChat,
  personal = false,
}: {
  card: ProjectRowView;
  hosts: string;
  filtered: boolean;
  canStart: boolean;
  onFilter: () => void;
  /** Absent where the row has no new chat button. */
  onNewChat?: (() => void) | undefined;
  /** Aide's row: its chats are topics. */
  personal?: boolean;
}) {
  const tx = useTx();
  const attention =
    card.complete === false && card.attention > 0 ? `${card.attention}+` : String(card.attention);
  return (
    <div
      className={`studio-row studio-side-row studio-project${card.attention > 0 ? " needs-you" : ""}`}
    >
      <ProjectFavicon project={card.group} className="studio-project-icon" />
      <Link
        to="/projects/$projectKey"
        params={{ projectKey: card.group.projectKey }}
        className="studio-row-main studio-row-link"
      >
        <span className="studio-row-title">{card.group.displayName}</span>
        {hosts ? <span className="studio-row-meta">{hosts}</span> : null}
      </Link>
      <span className="studio-row-counts">
        {card.attention > 0 ? (
          <button
            type="button"
            className="studio-pill amber"
            aria-pressed={filtered}
            aria-label={
              personal
                ? tx("Show only topics that need you in {project}", {
                    project: card.group.displayName,
                  })
                : tx("Show only chats that need you in {project}", {
                    project: card.group.displayName,
                  })
            }
            onClick={onFilter}
          >
            {attention}
          </button>
        ) : null}
        {card.working > 0 ? (
          <span className="studio-pill moss">
            <span className="sr-only">{tx("Working")}: </span>
            {card.working}
          </span>
        ) : null}
        {onNewChat ? (
          <button
            type="button"
            className="studio-icon-button"
            disabled={!canStart}
            aria-label={
              personal
                ? tx("New topic in {title}", { title: card.group.displayName })
                : tx("New chat in {project}", { project: card.group.displayName })
            }
            onClick={onNewChat}
          >
            <PlusIcon aria-hidden="true" />
          </button>
        ) : null}
      </span>
    </div>
  );
}

export type MachineRowView = {
  readonly environmentId: string;
  readonly label: string;
  readonly status: string;
  readonly tone: "moss" | "amber" | "red";
  readonly version: string | null;
  readonly attention: number;
  readonly projects: number;
  readonly thisMachine: boolean;
};

/** A machine: picking it shows only its chats and projects; the gear opens Connections. */
export function MachineRow({
  machine,
  selected,
  onSelect,
}: {
  machine: MachineRowView;
  selected: boolean;
  onSelect: () => void;
}) {
  const tx = useTx();
  return (
    <div className={`studio-row studio-side-row studio-machine${selected ? " selected" : ""}`}>
      <span className={`studio-state-dot ${machine.tone}`} aria-hidden="true" />
      <button
        type="button"
        className="studio-row-main studio-row-link"
        aria-pressed={selected}
        onClick={onSelect}
      >
        <span className="studio-row-title">
          {machine.label}
          {machine.thisMachine ? (
            <span className="studio-row-note"> · {tx("this machine")}</span>
          ) : null}
        </span>
        <span className="studio-row-meta">
          {[
            // The green dot already says connected; any other state is spelled out.
            machine.tone === "moss" ? null : machine.status,
            machine.version,
            tx(machine.projects === 1 ? "{count} project" : "{count} projects", {
              count: machine.projects,
            }),
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </button>
      <span className="studio-row-counts">
        {machine.attention > 0 ? (
          <span className="studio-pill amber">
            <span className="sr-only">{tx("Chats that need you")}: </span>
            {machine.attention}
          </span>
        ) : null}
        <Link
          to="/settings/connections"
          className="studio-icon-button"
          aria-label={tx("Connection settings for {machine}", { machine: machine.label })}
        >
          <SettingsIcon aria-hidden="true" />
        </Link>
      </span>
    </div>
  );
}

function typing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
  );
}

/**
 * J/K walk the chat rows, Enter opens the focused one (a native link), N starts a
 * chat and / focuses the filter. Keys count only while focus is on the page or in
 * Overview, never while typing or with a modifier held.
 */
export function useOverviewKeys(
  root: React.RefObject<HTMLElement | null>,
  actions: { onNewChat: () => void; onFilter: () => void },
) {
  const { onNewChat, onFilter } = actions;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (typing(event.target) || isCommandPaletteOpen()) return;
      // A picker's own typeahead (the new-chat chooser's project field) keeps its keys.
      if (
        event.target instanceof Element &&
        event.target.closest('[role="combobox"], [role="listbox"], .studio-draft-chooser')
      )
        return;
      const element = root.current;
      if (!element) return;
      const active = document.activeElement;
      if (active && active !== document.body && !element.contains(active)) return;
      const key = event.key.toLowerCase();
      if (key === "j" || key === "k") {
        const rows = [...element.querySelectorAll<HTMLElement>("[data-overview-row]")];
        if (rows.length === 0) return;
        const index = rows.indexOf(active as HTMLElement);
        const next =
          index === -1
            ? key === "j"
              ? 0
              : rows.length - 1
            : Math.min(rows.length - 1, Math.max(0, index + (key === "j" ? 1 : -1)));
        event.preventDefault();
        rows[next]!.focus();
        rows[next]!.scrollIntoView?.({ block: "nearest" });
      } else if (key === "n" && !event.shiftKey) {
        event.preventDefault();
        onNewChat();
      } else if (event.key === "/") {
        event.preventDefault();
        onFilter();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [root, onNewChat, onFilter]);
}
