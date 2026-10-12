import {
  PERSONAL_ASSISTANT_LABEL,
  resolveEnvironmentMachineKind,
} from "@specweave-studio/contracts";
import type { EnvironmentId } from "@specweave-studio/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { useEnvironments } from "../../state/environments";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ProjectFavicon } from "../ProjectFavicon";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { SettingsScopeChoiceList, type ScopeChoice } from "./SettingsScopeChoiceList";
import { useSettingsScope } from "./SettingsScopeContext";
import type { SettingsScopeSearch } from "./settingsScope";
import { SettingsPageContainer } from "./settingsLayout";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";

type ScopeTargetChoice = ScopeChoice & { readonly search: SettingsScopeSearch };

const NOUN = { project: "projects", checkout: "checkouts", environment: "environments" } as const;

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
  const { environments } = useEnvironments();
  const groups = useSettingsProjectGroups();
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

  const choices: ScopeTargetChoice[] =
    target === "checkout"
      ? groups
          .filter((group) => !search.project || group.projectKey === search.project)
          .flatMap((group) =>
            group.memberProjects.map((member) => ({
              key: `${group.projectKey}:${member.physicalProjectKey}`,
              label: `${group.displayName} · ${member.environmentLabel ?? "Environment"}`,
              detail: member.workspaceRoot,
              icon: <ProjectFavicon project={member} className="size-5" />,
              search: {
                project: group.projectKey,
                machine: member.environmentId,
                checkout: member.physicalProjectKey,
              },
            })),
          )
      : target === "project"
        ? groups
            .map((group) => {
              const checkouts = group.memberProjects.length;
              return {
                key: group.projectKey,
                label: group.displayName,
                detail:
                  group.workspaceSettings?.kind === "personal"
                    ? PERSONAL_ASSISTANT_LABEL
                    : checkouts > 1
                      ? `${checkouts} checkouts · ${group.workspaceRoot}`
                      : group.workspaceRoot,
                icon: <ProjectFavicon project={group} className="size-5" />,
                badge: group.workspaceSettings?.archived ? "Archived" : undefined,
                search: { project: group.projectKey },
              };
            })
            // Archived projects stay reachable, after the ones still taking work.
            .sort((a, b) => Number(a.badge !== undefined) - Number(b.badge !== undefined))
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
        {choices.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing to choose yet.</p>
        ) : (
          <SettingsScopeChoiceList
            // A different list starts with a fresh search and the first page.
            key={target}
            choices={choices}
            noun={NOUN[target]}
            onPick={(choice) => pick(choice.search)}
          />
        )}
      </div>
    </SettingsPageContainer>
  );
}
