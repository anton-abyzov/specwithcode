import { resolveEnvironmentMachineKind } from "@specweave-studio/contracts";
import type { EnvironmentId } from "@specweave-studio/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { useServerConfigs } from "../../state/entities";
import { useNamedEnvironments } from "./useNamedEnvironments";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { ArchivedDisclosure } from "./ArchivedDisclosure";
import { SettingsScopeChoiceList, type ScopeChoice } from "./SettingsScopeChoiceList";
import { useSettingsScope } from "./SettingsScopeContext";
import type { SettingsScopeSearch } from "./settingsScope";
import { SettingsPageContainer } from "./settingsLayout";
import {
  settingsScopeNoticeCheckouts,
  settingsScopeNoticeProjects,
  type ScopeNoticeEntry,
} from "./settingsScopeNoticeChoices";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";

type ScopeTargetChoice = ScopeChoice & { readonly search: SettingsScopeSearch };

const NOUN = { project: "projects", checkout: "checkouts", environment: "environments" } as const;

function withFavicon(entry: ScopeNoticeEntry<ProjectFaviconProject>): ScopeTargetChoice {
  return { ...entry, icon: <ProjectFavicon project={entry.project} className="size-5" /> };
}

/** Offer an explicit target change when a category has no settings at this scope. */
export function SettingsScopeNotice({
  children,
  target,
  targetId,
  eligibleEnvironmentIds,
}: {
  children: string;
  target: "environment" | "all" | "project" | "checkout";
  targetId?: string;
  eligibleEnvironmentIds?: readonly EnvironmentId[];
}) {
  const { selectScope, search } = useSettingsScope();
  const navigate = useNavigate({ from: "/settings" });
  const pathname = useLocation({ select: (location) => location.pathname });
  const { environments } = useNamedEnvironments();
  const groups = useSettingsProjectGroups();
  const configs = useServerConfigs();
  const pick = (next: SettingsScopeSearch) => {
    if (targetId) void navigate({ to: pathname, search: () => next, hash: targetId });
    else selectScope(next);
  };

  if (target === "all") {
    return (
      <SettingsPageContainer>
        <Alert role="status">
          <AlertDescription>
            <p>{children}</p>
            <AlertAction>
              <Button size="sm" variant="outline" onClick={() => pick({})}>
                Open all environments
              </Button>
            </AlertAction>
          </AlertDescription>
        </Alert>
      </SettingsPageContainer>
    );
  }

  const scratchRootFor = (environmentId: EnvironmentId) =>
    configs.get(environmentId)?.scratchWorkspaceRoot ?? null;
  const projectEntries =
    target === "checkout"
      ? settingsScopeNoticeCheckouts(groups, scratchRootFor, search.project)
      : target === "project"
        ? settingsScopeNoticeProjects(groups, scratchRootFor, search.project)
        : null;
  const archivedChoices = projectEntries?.archived.map(withFavicon) ?? [];
  const choices: ScopeTargetChoice[] = projectEntries
    ? projectEntries.listed.map(withFavicon)
    : environments
        .filter(
          (entry) =>
            eligibleEnvironmentIds === undefined ||
            eligibleEnvironmentIds.includes(entry.environmentId),
        )
        .map((entry) => ({
          key: entry.environmentId,
          label: entry.label,
          detail: entry.displayUrl || entry.environmentId,
          icon: (
            <EnvironmentMachineIcon
              aria-hidden
              kind={resolveEnvironmentMachineKind(entry.serverConfig)}
              className="size-4.5 text-muted-foreground"
            />
          ),
          badge: entry.connection.phase === "connected" ? undefined : "Offline",
          search: { machine: entry.environmentId },
        }));

  return (
    <SettingsPageContainer>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">{children}</p>
        {choices.length === 0 && archivedChoices.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing to choose yet.</p>
        ) : choices.length > 0 ? (
          <SettingsScopeChoiceList
            // A different list starts with a fresh search and the first page.
            key={target}
            choices={choices}
            noun={NOUN[target]}
            onPick={(choice) => pick(choice.search)}
          />
        ) : null}
        {/* Archived projects stay reachable, folded away from the ones still taking work. */}
        <ArchivedDisclosure count={archivedChoices.length}>
          <SettingsScopeChoiceList
            key={`${target}:archived`}
            choices={archivedChoices}
            noun={`archived ${NOUN[target]}`}
            onPick={(choice) => pick(choice.search)}
          />
        </ArchivedDisclosure>
      </div>
    </SettingsPageContainer>
  );
}
