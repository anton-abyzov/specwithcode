import { AuthSettingsWriteScope, type AuthEnvironmentScope } from "@specweave-studio/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CircleDotIcon, LayoutGridIcon, MonitorIcon, SmartphoneIcon } from "lucide-react";
import { useRef, type KeyboardEvent, type ReactNode } from "react";

import { useTx } from "../../../i18n";
import { cn } from "../../../lib/utils";
import { hostReachOr, machineReachWords } from "../../../lib/machineStatus";
import { useEnvironmentScopeAccess } from "../../../state/session";
import { useSettingsScope } from "../SettingsScopeContext";
import {
  INTEGRATIONS_TABS,
  type IntegrationsTab,
  type IntegrationsTabId,
} from "./integrationsTabs";

const TAB_ICONS: Readonly<Record<IntegrationsTabId, typeof MonitorIcon>> = {
  access: MonitorIcon,
  mcp: LayoutGridIcon,
  devices: SmartphoneIcon,
  preview: CircleDotIcon,
};

const tabElementId = (id: IntegrationsTabId) => `integrations-tab-${id}`;
const panelElementId = (id: IntegrationsTabId) => `integrations-panel-${id}`;

/** The tab an arrow, Home or End key moves to, or null for any other key. */
export function integrationsTabAfterKey(
  current: IntegrationsTabId,
  key: string,
): IntegrationsTabId | null {
  const index = INTEGRATIONS_TABS.findIndex((tab) => tab.id === current);
  const count = INTEGRATIONS_TABS.length;
  const next =
    key === "ArrowRight" || key === "ArrowDown"
      ? (index + 1) % count
      : key === "ArrowLeft" || key === "ArrowUp"
        ? (index + count - 1) % count
        : key === "Home"
          ? 0
          : key === "End"
            ? count - 1
            : -1;
  return next < 0 ? null : INTEGRATIONS_TABS[next]!.id;
}

/**
 * Two columns of buttons in a narrow settings window, one underlined row once
 * there is room. Each tab is its own page, so a tab change is a navigation
 * that keeps the selected machine.
 */
export function IntegrationsTabStrip({ current }: { readonly current: IntegrationsTabId | null }) {
  const tx = useTx();
  const navigate = useNavigate();
  const listRef = useRef<HTMLDivElement>(null);
  const open = (tab: IntegrationsTab) =>
    navigate({ to: tab.path, hash: "", replace: true, hashScrollIntoView: false });
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (current === null) return;
    const nextId = integrationsTabAfterKey(current, event.key);
    if (nextId === null) return;
    event.preventDefault();
    const next = INTEGRATIONS_TABS.find((tab) => tab.id === nextId)!;
    // The strip stays mounted across tabs, so focus can follow the selection.
    void open(next).then(() =>
      listRef.current?.querySelector<HTMLElement>(`#${tabElementId(next.id)}`)?.focus(),
    );
  };
  return (
    <div className="@container/integrations-tabs px-3 sm:px-4">
      <div
        ref={listRef}
        role="tablist"
        aria-label={tx("Integrations sections")}
        className="grid grid-cols-2 gap-1.5 @xl/integrations-tabs:flex @xl/integrations-tabs:gap-0.5 @xl/integrations-tabs:border-b @xl/integrations-tabs:border-border"
        onKeyDown={onKeyDown}
      >
        {INTEGRATIONS_TABS.map((tab) => {
          const selected = tab.id === current;
          const Icon = TAB_ICONS[tab.id];
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={tabElementId(tab.id)}
              aria-selected={selected}
              aria-controls={panelElementId(tab.id)}
              tabIndex={selected || current === null ? 0 : -1}
              className={cn(
                "flex min-h-9 min-w-0 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-2 text-start text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                "@xl/integrations-tabs:-mb-px @xl/integrations-tabs:rounded-b-none @xl/integrations-tabs:border-0 @xl/integrations-tabs:border-b-2 @xl/integrations-tabs:border-transparent @xl/integrations-tabs:bg-transparent @xl/integrations-tabs:px-3",
                selected &&
                  "border-primary bg-accent font-medium text-foreground @xl/integrations-tabs:border-primary @xl/integrations-tabs:bg-transparent",
              )}
              onClick={() => void open(tab)}
            >
              {/* In the narrowest window the label needs the icon's room to stay on whole words. */}
              <Icon aria-hidden className="hidden size-3.5 shrink-0 @sm/integrations-tabs:block" />
              <span className="min-w-0 [overflow-wrap:anywhere]">{tx(tab.label)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The content of one tab, named by its tab for assistive technology. */
export function IntegrationsTabPanel({
  tab,
  children,
}: {
  readonly tab: IntegrationsTabId;
  readonly children: ReactNode;
}) {
  return (
    <div
      role="tabpanel"
      id={panelElementId(tab)}
      aria-labelledby={tabElementId(tab)}
      className="flex min-w-0 flex-col gap-8"
    >
      {children}
    </div>
  );
}

/**
 * What a per-machine tab shows in place of, or above, its rows when the
 * machine cannot be set up right now: gone from the list, not connected, or
 * reached with a sign-in that may look but not change.
 */
export function IntegrationsMachineState({
  children,
  links,
  changeScope = AuthSettingsWriteScope,
  disableRows = true,
}: {
  readonly children: ReactNode;
  /** Rows that only lead elsewhere; they stay usable for a sign-in that may only look. */
  readonly links?: ReactNode;
  /** The grant this tab's changes need. */
  readonly changeScope?: AuthEnvironmentScope;
  /** False for rows that turn their own controls off and stay open to read. */
  readonly disableRows?: boolean;
}) {
  const tx = useTx();
  const { scope, environments } = useSettingsScope();
  const environmentId = scope.kind === "environment" ? scope.environmentId : null;
  const machine =
    environments.find((environment) => environment.environmentId === environmentId) ?? null;
  // Judged from the connection alone, as the scope line's status is, so the two never disagree.
  const reach = machine ? hostReachOr(undefined, machine.connection) : null;
  const away = reach !== null && reach !== "connected";
  // "denied" is a sign-in that may read only; a session still loading or
  // signed out says nothing about what this sign-in may change.
  const viewOnly = useEnvironmentScopeAccess(away ? null : environmentId, changeScope) === "denied";
  const locked = viewOnly && disableRows;
  if (scope.kind === "unavailable") {
    return (
      <p role="status" className="px-3 text-sm text-muted-foreground sm:px-4">
        {scope.message}
      </p>
    );
  }
  if (machine && reach !== null && away) {
    // A machine that is still on its way says so; only one that is down
    // sends the reader to another machine.
    const arriving = reach === "connecting" || reach === "catching-up" || reach === "reconnecting";
    return (
      <div
        role="status"
        data-testid="integrations-machine-away"
        data-reach={reach}
        className="rounded-xl border border-border bg-card px-4 py-6 text-center"
      >
        <p className="text-base font-medium">
          {tx(machineReachWords(reach, machine.connection.phase).headline, {
            machine: scope.label,
          })}
        </p>
        {arriving ? null : (
          <p className="mt-1 text-sm text-muted-foreground">
            {tx(
              "Its settings show when it reconnects. Pick another machine above to set that one up.",
            )}
          </p>
        )}
      </div>
    );
  }
  return (
    <>
      {viewOnly ? (
        <p
          role="status"
          data-testid="integrations-machine-view-only"
          className="rounded-lg bg-muted px-3 py-2 text-sm text-foreground sm:px-4"
        >
          {tx("You can look at {machine}'s settings from this sign-in, but not change them.", {
            machine: scope.label,
          })}
        </p>
      ) : null}
      {/* `inert` is what the settings rows already use for a control that
          cannot be changed: nothing inside takes a click, focus or a key. A
          disabled fieldset would miss the switches, which are not form
          controls. The wrapper stays in the tree either way, so the rows keep
          their state when the grant arrives. */}
      <div
        inert={locked}
        data-testid="integrations-machine-rows"
        className={cn(
          "flex min-w-0 flex-col gap-8",
          // Only the controls dim; the words beside them stay as readable as ever.
          locked &&
            "[&_[role=combobox]]:opacity-60 [&_[role=switch]]:opacity-60 [&_button]:opacity-60 [&_input]:opacity-60",
        )}
      >
        {children}
      </div>
      {links}
    </>
  );
}
