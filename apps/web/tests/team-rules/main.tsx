import type { RuntimeMode, TeamRulesSummary } from "@specweave-studio/contracts";
import { teamRulesModeAllowed } from "@specweave-studio/shared/teamRules";
import { ShieldAlertIcon } from "lucide-react";
import { createRoot } from "react-dom/client";

import { ComposerBannerStack } from "../../src/components/chat/ComposerBannerStack";
import { runtimeModeConfig, runtimeModeOptions } from "../../src/components/chat/runtimeModeConfig";
import { TeamRulesSectionView } from "../../src/components/settings/TeamRulesSection";
import {
  SettingsRow,
  SettingsSection,
  TeamRulesLabel,
} from "../../src/components/settings/settingsLayout";
import { Button } from "../../src/components/ui/button";
import { Input } from "../../src/components/ui/input";
import {
  TEAM_RULES_ABOVE_LIMIT,
  teamRulesFromSummary,
  teamRulesProviderLock,
  teamRulesThreadNotice,
} from "../../src/teamRules/teamRulesView";
import "./fixture.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");

const active: TeamRulesSummary = {
  status: "active",
  owner: "Acme Engineering",
  contact: "https://it.acme.example/ai",
  fingerprint: "fixture",
  ceiling: "approval-required",
  routinesCeiling: "approval-required",
  providers: ["claudeAgent", "codex"],
  models: ["claude-*", "gpt-*"],
  ownsProviderLaunch: true,
  telemetryExport: false,
};
const hold: TeamRulesSummary = {
  status: "hold",
  contact: "https://it.acme.example/ai",
  issues: ["agents.ceiling: expected one of the permission modes"],
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

function Menu() {
  const { state } = teamRulesFromSummary(active);
  return (
    <div className="mx-auto max-w-sm space-y-1 p-6" role="listbox" aria-label="Access">
      {runtimeModeOptions.map((mode: RuntimeMode) => {
        const allowed = teamRulesModeAllowed(state, mode);
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
}: {
  readonly summary: TeamRulesSummary;
  readonly mode: RuntimeMode;
}) {
  const notice = teamRulesThreadNotice(summary, mode);
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
createRoot(document.getElementById("root")!).render(
  view === "menu" ? (
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
