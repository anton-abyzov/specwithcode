import {
  EnvironmentId,
  type RuntimeMode,
  type TeamRulesCarried,
  type TeamRulesSummary,
} from "@specweave-studio/contracts";
import {
  teamRulesStateFromSummary,
  teamRulesThreadModeAllowed,
} from "@specweave-studio/shared/teamRules";
import { ShieldAlertIcon } from "lucide-react";
import { createRoot } from "react-dom/client";

import { ComposerBannerStack } from "../../src/components/chat/ComposerBannerStack";
import { runtimeModeConfig, runtimeModeOptions } from "../../src/components/chat/runtimeModeConfig";
import { MachineListSection } from "../../src/components/settings/MachinesSettings";
import { buildMachineRows } from "../../src/components/settings/machinesSettings.logic";
import { PairPhoneSettings } from "../../src/components/settings/PairPhoneSettings";
import { StudioFleetRoster } from "../../src/components/settings/StudioFleetConnections";
import { TeamRulesInert, TeamRulesLockNote } from "../../src/components/settings/TeamRulesLock";
import { TeamRulesSectionView } from "../../src/components/settings/TeamRulesSection";
import {
  SettingsRow,
  SettingsSection,
  TeamRulesLabel,
} from "../../src/components/settings/settingsLayout";
import { Button } from "../../src/components/ui/button";
import { Input } from "../../src/components/ui/input";
import { Switch } from "../../src/components/ui/switch";
import {
  TEAM_RULES_ABOVE_LIMIT,
  teamRulesFromSummary,
  teamRulesProviderLock,
  teamRulesReachLock,
  teamRulesThreadNotice,
  teamRulesToolLock,
} from "../../src/teamRules/teamRulesView";
import "./fixture.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");

const active: TeamRulesSummary = {
  status: "active",
  owner: "Acme Engineering",
  contact: "https://it.acme.example/ai",
  fingerprint: "fixture00000",
  ceiling: "approval-required",
  routinesCeiling: "approval-required",
  providers: ["claudeAgent", "codex"],
  models: ["claude-*", "gpt-*"],
  ownsProviderLaunch: true,
  telemetryExport: false,
  reach: { phones: false, connect: false, machines: "same-rules", webhooks: false },
  tools: { chrome: false, computerUse: false, google: false, telegram: false },
};
const hold: TeamRulesSummary = {
  status: "hold",
  contact: "https://it.acme.example/ai",
  issues: ["agents.ceiling: expected one of the permission modes"],
};

const summaryFor = (name: string | null) => (name === "none" ? undefined : active);
const ids = {
  m4: EnvironmentId.make("env-m4"),
  build: EnvironmentId.make("env-build"),
  laptop: EnvironmentId.make("env-laptop"),
  broken: EnvironmentId.make("env-broken"),
  away: EnvironmentId.make("env-away"),
};

/** Five machines, one for each answer the drift badge can give. */
function fleetSnapshot(withRules: boolean) {
  const machine = (environmentId: EnvironmentId, label: string, extra: object = {}) => ({
    id: label.toLowerCase().replaceAll(" ", "-"),
    environmentId,
    label,
    url: `https://${label.toLowerCase().replaceAll(" ", "-")}.example`,
    status: "reachable" as const,
    pairingConfigured: true,
    ...extra,
  });
  return {
    configured: true,
    connectPermission: "access:write" as const,
    observedAt: "2026-11-02T12:00:00Z",
    listener: "network" as const,
    machines: [
      machine(ids.m4, "M4 Studio"),
      machine(
        ids.build,
        "Linux build box",
        withRules ? { teamRules: { status: "active", fingerprint: "fixture00000" } } : {},
      ),
      machine(ids.laptop, "Personal laptop"),
      machine(ids.broken, "Mac mini", withRules ? { teamRules: { status: "hold" } } : {}),
      machine(ids.away, "Office iMac", withRules ? { status: "unreachable" } : {}),
    ],
  };
}

function Drift({ summary }: { readonly summary: TeamRulesSummary | undefined }) {
  const rows = buildMachineRows({
    environments: [
      {
        environmentId: ids.m4,
        label: "M4 Studio",
        phase: "connected",
        statusText: "Connected",
        teamRules: summary,
        configKnown: true,
      },
    ],
    primaryEnvironmentId: ids.m4,
    fleet: fleetSnapshot(summary !== undefined) as never,
    canPair: true,
    projects: [],
    hostBlocks: [],
  });
  return (
    <div className="mx-auto max-w-3xl p-6">
      <MachineListSection
        rows={rows}
        loading={false}
        pending={null}
        error={null}
        onRefresh={() => undefined}
        onConnect={() => undefined}
      />
    </div>
  );
}

function Reach({ summary }: { readonly summary: TeamRulesSummary | undefined }) {
  const connect = teamRulesReachLock(summary, "connect");
  const webhooks = teamRulesReachLock(summary, "webhooks");
  return (
    <div className="mx-auto max-w-3xl space-y-8 p-6">
      <PairPhoneSettings
        endpoint={null}
        serverEndpoints={undefined}
        canCreateLinks
        delegatableScopes={[]}
        onPairingLinkCreated={() => undefined}
        hasAccessControls
        onShowAccessSettings={() => undefined}
        teamRulesLock={teamRulesReachLock(summary, "phones")}
      />
      <SettingsSection title="SpecWithCode Connect">
        <SettingsRow
          title="SpecWithCode Connect"
          description={connect?.message ?? "Make this environment available to your other devices."}
          status={connect ? <TeamRulesLabel>{connect.setBy}</TeamRulesLabel> : undefined}
          control={
            <TeamRulesInert lock={connect}>
              <Switch aria-label="SpecWithCode Connect" checked={false} />
            </TeamRulesInert>
          }
        />
        <SettingsRow
          title="Hold webhooks while offline"
          description={webhooks?.message ?? "Keep webhook requests for up to 24 hours."}
          status={webhooks ? <TeamRulesLabel>{webhooks.setBy}</TeamRulesLabel> : undefined}
          control={
            <TeamRulesInert lock={webhooks}>
              <Switch aria-label="Hold webhooks" checked={false} />
            </TeamRulesInert>
          }
        />
      </SettingsSection>
      <StudioFleetRoster
        teamRules={summary}
        snapshot={fleetSnapshot(summary !== undefined) as never}
        loading={false}
        failed={false}
        canPair
        environmentId={ids.m4}
        savedEnvironmentIds={[]}
        pending={null}
        error={null}
        onRefresh={() => undefined}
        onPair={() => undefined}
        canManageWorkers
        invitation=""
        onInvitationChange={() => undefined}
        onAddMachine={() => undefined}
        onInvite={() => undefined}
      />
    </div>
  );
}

function Tools({ summary }: { readonly summary: TeamRulesSummary | undefined }) {
  const rows = [
    { key: "chrome", title: "Chrome for agents", detail: "Agents use your real Chrome." },
    { key: "computerUse", title: "Agent computer access", detail: "Agents control this desktop." },
    { key: "google", title: "Connect Google", detail: "Agents read your Gmail and Calendar." },
    { key: "telegram", title: "Telegram", detail: "Talk to a coordinator from your phone." },
  ] as const;
  return (
    <div className="mx-auto max-w-3xl space-y-8 p-6">
      <SettingsSection title="Agent tools">
        {rows.map((row) => {
          const lock = teamRulesToolLock(summary, row.key);
          return (
            <SettingsRow
              key={row.key}
              title={row.title}
              description={lock?.message ?? row.detail}
              status={lock ? <TeamRulesLabel>{lock.setBy}</TeamRulesLabel> : undefined}
              control={
                <TeamRulesInert lock={lock}>
                  <Switch aria-label={row.title} checked={false} />
                </TeamRulesInert>
              }
            />
          );
        })}
      </SettingsSection>
      {summary === undefined ? null : (
        <div data-testid="disconnect" className="space-y-2">
          <TeamRulesLockNote lock={teamRulesToolLock(summary, "google")!} />
          <Button size="sm" variant="outline">
            Disconnect
          </Button>
        </div>
      )}
    </div>
  );
}

const carried: TeamRulesCarried = {
  ceiling: "auto-accept-edits",
  owner: "Acme Engineering",
  from: ids.m4,
};

function Settings() {
  const rules = teamRulesFromSummary(active);
  return (
    <div className="mx-auto max-w-3xl space-y-8 p-6">
      <TeamRulesSectionView summary={active} />
      <SettingsSection title="New threads">
        <SettingsRow
          title="Default permissions"
          description="Default permissions for new threads. Projects can override them."
          status={<TeamRulesLabel>{rules.setBy}</TeamRulesLabel>}
          control={<Button size="sm">{runtimeModeConfig["approval-required"].label}</Button>}
        />
        <SettingsRow
          title="Launch arguments"
          description="Extra arguments for this provider."
          status={<TeamRulesLabel>{teamRulesProviderLock(active, "codex") ?? ""}</TeamRulesLabel>}
          control={
            <div inert className="opacity-50 select-none">
              <Input aria-label="Launch arguments" defaultValue="--profile fixture" />
            </div>
          }
        />
      </SettingsSection>
    </div>
  );
}

function Menu({ carriedLimit }: { readonly carriedLimit?: TeamRulesCarried }) {
  // With a carried limit the machine itself has no rules: the ceiling came with the work.
  const state = teamRulesStateFromSummary(carriedLimit === undefined ? active : undefined);
  return (
    <div className="mx-auto max-w-sm space-y-1 p-6" role="listbox" aria-label="Access">
      {runtimeModeOptions.map((mode: RuntimeMode) => {
        const allowed = teamRulesThreadModeAllowed(state, carriedLimit, mode);
        return (
          <div
            key={mode}
            role="option"
            aria-disabled={!allowed}
            aria-selected={mode === "approval-required"}
            className={allowed ? "rounded-sm px-2 py-1" : "rounded-sm px-2 py-1 opacity-50"}
          >
            <div className="text-sm font-medium">{runtimeModeConfig[mode].label}</div>
            <div className="text-xs text-muted-foreground">
              {allowed ? runtimeModeConfig[mode].description : TEAM_RULES_ABOVE_LIMIT}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Notice({
  summary,
  mode,
  carriedLimit,
}: {
  readonly summary: TeamRulesSummary | undefined;
  readonly mode: RuntimeMode;
  readonly carriedLimit?: TeamRulesCarried;
}) {
  const notice = teamRulesThreadNotice(summary, mode, carriedLimit);
  if (notice === null) return null;
  return (
    <div className="mx-auto max-w-2xl p-6">
      <ComposerBannerStack
        items={[
          {
            id: `team-rules:${notice.kind}`,
            variant: "warning",
            priority: "urgent",
            icon: <ShieldAlertIcon />,
            title: notice.title,
            description: notice.description,
            ...(notice.kind === "above-ceiling"
              ? {
                  actions: (
                    <Button size="xs" variant="outline">
                      {notice.switchLabel}
                    </Button>
                  ),
                }
              : {}),
          },
        ]}
      />
    </div>
  );
}

const view = params.get("view") ?? "settings";
const rules = summaryFor(params.get("rules"));
createRoot(document.getElementById("root")!).render(
  view === "reach" ? (
    <Reach summary={rules} />
  ) : view === "tools" ? (
    <Tools summary={rules} />
  ) : view === "drift" ? (
    <Drift summary={rules} />
  ) : view === "carried" ? (
    <>
      <Menu carriedLimit={carried} />
      <Notice summary={undefined} mode="full-access" carriedLimit={carried} />
    </>
  ) : view === "menu" ? (
    <Menu />
  ) : view === "above" ? (
    <Notice summary={active} mode="full-access" />
  ) : view === "hold" ? (
    <>
      <Notice summary={hold} mode="approval-required" />
      <div className="mx-auto max-w-3xl p-6">
        <TeamRulesSectionView summary={hold} />
      </div>
    </>
  ) : (
    <Settings />
  ),
);
