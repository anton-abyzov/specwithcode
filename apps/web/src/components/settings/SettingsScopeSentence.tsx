import { resolveEnvironmentMachineKind } from "@specweave-studio/contracts";
import { useLocation } from "@tanstack/react-router";
import { ChevronDownIcon, LayersIcon } from "lucide-react";
import type { ReactNode } from "react";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useServerConfigs } from "../../state/entities";
import { ineligibleProjectLabel } from "../../studio/projectListVisibility";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ProjectFavicon } from "../ProjectFavicon";
import { InlineButton } from "../ui/button";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { useOptionalSettingsScope } from "./SettingsScopeContext";
import { settingsPageScope } from "./settingsPageScope";
import { resolveSettingsScope, type SettingsScopeSearch } from "./settingsScope";
import {
  ALL_ENVIRONMENTS_VALUE,
  ALL_PROJECTS_VALUE,
  environmentAxisValue,
  projectAxisValue,
  selectEnvironmentAxis,
  selectProjectAxis,
  settingsScopeEnvironmentLabel,
  settingsScopeProjectChoices,
} from "./settingsScopeAxis";

/** Pages whose every row is saved on this client; they have no scope to pick. */
export const SETTINGS_DEVICE_ONLY_PATHS: ReadonlySet<string> = new Set([
  "/settings/appearance",
  "/settings/snap-shot",
  "/settings/connections",
  "/settings/machines",
  "/settings/chrome",
]);

interface SettingsScopeMenuProps {
  readonly value: SettingsScopeSearch;
  readonly groups: readonly SidebarProjectSnapshot[];
  readonly environments: readonly EnvironmentPresentation[];
  readonly singleEnvironment: boolean;
  readonly onChange: (next: SettingsScopeSearch) => void;
}

/**
 * The target line at the top of a settings page. Global pages have none: they
 * apply to every project on every machine. Machine pages name the machine
 * once there is more than one. Only the Project pages pick a project.
 */
export function SettingsScopeSentence() {
  const scope = useOptionalSettingsScope();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { environments } = useEnvironments();
  if (scope === null || SETTINGS_DEVICE_ONLY_PATHS.has(pathname)) return null;
  const pageScope = settingsPageScope(pathname);
  if (pageScope === "global") return null;
  if (pageScope === "machine" && environments.length < 2) return null;
  const props: SettingsScopeMenuProps = {
    value: scope.search,
    singleEnvironment: scope.singleEnvironment,
    groups: scope.groups,
    environments,
    onChange: scope.selectScope,
  };
  const connective =
    // A legacy checkout link names one environment without `machine`.
    scope.search.machine || scope.scope.kind === "checkout" ? "on" : "across";
  if (pageScope === "machine") {
    return (
      <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 px-3 text-base text-muted-foreground sm:px-4">
        <span className="shrink-0">Applying settings {connective}</span>
        <EnvironmentScopeMenu {...props} />
      </p>
    );
  }
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 px-3 text-base text-muted-foreground sm:px-4">
      {/* Each connective stays with its picker so a wrap never strands "on". */}
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0">Applying settings for</span>
        <ProjectScopeMenu {...props} />
      </span>
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0">{connective}</span>
        <EnvironmentScopeMenu {...props} />
      </span>
    </p>
  );
}

function ScopeMenu({
  ariaLabel,
  icon,
  label,
  children,
}: {
  ariaLabel: string;
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <Menu>
      <MenuTrigger
        aria-label={`${ariaLabel}: ${label}`}
        render={<InlineButton tone="picker" />}
        className="min-w-0 max-w-72"
      >
        {icon}
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      </MenuTrigger>
      <MenuPopup align="start">{children}</MenuPopup>
    </Menu>
  );
}

function EnvironmentScopeMenu({
  value,
  groups,
  environments,
  onChange,
  singleEnvironment,
}: SettingsScopeMenuProps) {
  const resolved = resolveSettingsScope(value, groups, environments);
  const environmentValue = environmentAxisValue(
    value,
    resolved.kind === "checkout" ? resolved.environmentId : null,
  );
  const selected = environments.find(
    (environment) => environment.environmentId === environmentValue,
  );
  // A picked project only has settings on the environments that check it out.
  const projectEnvironmentIds = value.project
    ? new Set(
        groups
          .find((group) => group.projectKey === value.project)
          ?.memberProjects.map((member) => member.environmentId),
      )
    : null;
  return (
    <ScopeMenu
      ariaLabel="Environment scope"
      icon={
        selected ? (
          <EnvironmentMachineIcon
            aria-hidden
            kind={resolveEnvironmentMachineKind(selected.serverConfig)}
            className="size-3.5 shrink-0"
          />
        ) : null
      }
      label={
        selected
          ? settingsScopeEnvironmentLabel(selected, environments)
          : environmentValue !== ALL_ENVIRONMENTS_VALUE
            ? "Unavailable environment"
            : singleEnvironment
              ? "No environments"
              : "All environments"
      }
    >
      <MenuRadioGroup
        value={environmentValue}
        onValueChange={(next) => {
          if (typeof next === "string") onChange(selectEnvironmentAxis(value, next));
        }}
      >
        {!singleEnvironment ? (
          <>
            <MenuRadioItem value={ALL_ENVIRONMENTS_VALUE}>
              <span className="flex min-w-0 items-center gap-2">
                <LayersIcon aria-hidden className="size-3.5" />
                <span className="min-w-0 flex-1 truncate">All environments</span>
                <MenuRadioItemIndicator />
              </span>
            </MenuRadioItem>
            <MenuSeparator />
          </>
        ) : null}
        {environments.map((environment) => (
          <MenuRadioItem key={environment.environmentId} value={environment.environmentId}>
            <span className="flex min-w-0 items-center gap-2">
              <EnvironmentMachineIcon
                aria-hidden
                kind={resolveEnvironmentMachineKind(environment.serverConfig)}
                className="size-3.5"
              />
              <span className="min-w-0 flex-1 truncate">
                {settingsScopeEnvironmentLabel(environment, environments)}
              </span>
              {environment.connection.phase !== "connected" ? (
                <span className="shrink-0 text-xs text-muted-foreground">Offline</span>
              ) : projectEnvironmentIds && !projectEnvironmentIds.has(environment.environmentId) ? (
                <span className="shrink-0 text-xs text-muted-foreground">No checkout</span>
              ) : null}
              <MenuRadioItemIndicator />
            </span>
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </ScopeMenu>
  );
}

function ProjectScopeMenu({ value, groups, onChange }: SettingsScopeMenuProps) {
  const configs = useServerConfigs();
  const selected = groups.find((group) => group.projectKey === value.project);
  const { choices, unavailable } = settingsScopeProjectChoices(
    groups,
    (environmentId) => configs.get(environmentId)?.scratchWorkspaceRoot ?? null,
    value.project,
  );
  return (
    <ScopeMenu
      ariaLabel="Project scope"
      icon={selected ? <ProjectFavicon project={selected} className="size-3.5 shrink-0" /> : null}
      label={selected?.displayName ?? (value.project ? "Unavailable project" : "All projects")}
    >
      <MenuRadioGroup
        value={projectAxisValue(value)}
        onValueChange={(next) => {
          if (typeof next === "string") onChange(selectProjectAxis(value, next));
        }}
      >
        <MenuRadioItem value={ALL_PROJECTS_VALUE}>
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate">All projects</span>
            <MenuRadioItemIndicator />
          </span>
        </MenuRadioItem>
        <MenuSeparator />
        {/* The current scope stays visible as context, never as a choice. */}
        {unavailable ? (
          <MenuRadioItem value={unavailable.project.projectKey} disabled>
            <span className="flex min-w-0 items-center gap-2">
              <ProjectFavicon project={unavailable.project} className="size-3.5" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{unavailable.project.displayName}</span>
                <span className="truncate text-muted-foreground text-xs">
                  {ineligibleProjectLabel(unavailable.reason)}
                </span>
              </span>
              <MenuRadioItemIndicator />
            </span>
          </MenuRadioItem>
        ) : null}
        {choices.map((group) => (
          <MenuRadioItem key={group.projectKey} value={group.projectKey}>
            <span className="flex min-w-0 items-center gap-2">
              <ProjectFavicon project={group} className="size-3.5" />
              <span className="min-w-0 flex-1 truncate">{group.displayName}</span>
              <MenuRadioItemIndicator />
            </span>
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </ScopeMenu>
  );
}
