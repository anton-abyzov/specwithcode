import { Outlet, createFileRoute, redirect, useLocation } from "@tanstack/react-router";
import { useMemo, useState, type ReactNode } from "react";
import { RotateCcwIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import { useSettingsRestore } from "../components/settings/SettingsPanels";

import { SettingsBreadcrumb } from "../components/settings/SettingsBreadcrumb";
import { SettingsDialog } from "../components/settings/SettingsDialog";
import { SettingsSidebarNav } from "../components/settings/SettingsSidebarNav";
import { SidebarInset } from "../components/ui/sidebar";
import { useNavigateToMainApp } from "../components/sidebar/mainAppLocation";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import {
  SettingsScopeProvider,
  useSettingsScope,
} from "../components/settings/SettingsScopeContext";
import { useEnvironments } from "../state/environments";
import { SettingsScopeNotice } from "../components/settings/SettingsScopeNotice";
import { SETTINGS_DEVICE_ONLY_PATHS } from "../components/settings/SettingsScopeSentence";
import { SettingsPageContainer } from "../components/settings/settingsLayout";
import {
  effectiveSettingsSearch,
  SETTINGS_SINGLE_MACHINE_PATHS,
  settingsSearchAfterScopeChange,
} from "../components/settings/settingsPageScope";
import { redirectSettingsEntry } from "../components/settings/settingsEntryScope";
import {
  retainSettingsScope,
  validateSettingsRouteSearch,
} from "../components/settings/settingsScopeNavigation";
import {
  getSettingsSearchTargetScope,
  getThreadAutoSettlementSearchAvailability,
  isSettingsSearchScopeAvailable,
} from "../components/settings/settingsSearch";

function RestoreDeviceDefaultsButton({ onRestored }: { onRestored: () => void }) {
  const { changedSettingLabels, restoreDefaults } = useSettingsRestore(onRestored);
  return (
    <Button
      size="xs"
      variant="ghost"
      disabled={changedSettingLabels.length === 0}
      onClick={() => void restoreDefaults()}
    >
      <RotateCcwIcon className="mx-1 size-3.5" />
      Restore device defaults
    </Button>
  );
}

function SettingsScopeBoundary({ pathname, children }: { pathname: string; children: ReactNode }) {
  const { scope, connectedEnvironments } = useSettingsScope();
  const { environments } = useEnvironments();
  const hash = useLocation({ select: (location) => location.hash });
  const searchTarget = getSettingsSearchTargetScope(hash);
  const autoSettlementAvailability = searchTarget?.requiresThreadAutoSettlement
    ? getThreadAutoSettlementSearchAvailability(environments, scope)
    : null;
  if (
    scope.kind !== "unavailable" &&
    searchTarget &&
    autoSettlementAvailability &&
    !autoSettlementAvailability.isTargetAvailable
  ) {
    return (
      <SettingsScopeNotice
        target="environment"
        targetId={hash}
        eligibleEnvironmentIds={autoSettlementAvailability.eligibleEnvironmentIds}
      >
        {autoSettlementAvailability.eligibleEnvironmentIds.length > 0
          ? `${searchTarget.title} requires a supporting environment. Choose one to continue.`
          : `${searchTarget.title} requires a supporting environment. Connect or update an environment to continue.`}
      </SettingsScopeNotice>
    );
  }
  if (
    scope.kind !== "unavailable" &&
    searchTarget &&
    !isSettingsSearchScopeAvailable(searchTarget.scope, scope.kind)
  ) {
    const target =
      searchTarget.scope === "environment" ||
      searchTarget.scope === "project" ||
      searchTarget.scope === "checkout"
        ? searchTarget.scope
        : "all";
    return (
      <SettingsScopeNotice target={target} targetId={hash}>
        {`${searchTarget.title} is not available for the selected target. Choose its owning scope to continue.`}
      </SettingsScopeNotice>
    );
  }
  // Device-local pages ignore the scope entirely; the project page follows
  // remembered members while a grouping change replaces its URL key.
  if (SETTINGS_DEVICE_ONLY_PATHS.has(pathname) || pathname === "/settings/projects") {
    return children;
  }
  // Keep the scope sentence on screen so the selection can be changed back.
  if (scope.kind === "unavailable")
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">{scope.message}</p>
      </SettingsPageContainer>
    );
  if (scope.kind === "environment" && connectedEnvironments.length === 0) {
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">
          Reconnect {scope.label} to change its settings.
        </p>
      </SettingsPageContainer>
    );
  }
  return children;
}

function SettingsContentLayout() {
  const location = useLocation();
  const navigateToMainApp = useNavigateToMainApp();
  const { search } = useSettingsScope();
  const [restoreSignal, setRestoreSignal] = useState(0);

  return (
    <>
      {/* The app stays in place, dimmed, under the settings sheet. */}
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
        <WorkspacePageHeader electron={isElectron}>{null}</WorkspacePageHeader>
      </SidebarInset>
      <SettingsDialog
        onClose={() => void navigateToMainApp()}
        nav={<SettingsSidebarNav pathname={location.pathname} />}
        header={
          <>
            <SettingsBreadcrumb pathname={location.pathname} />
            {location.pathname === "/settings/general" ? (
              <div className="ms-auto flex shrink-0 items-center">
                <RestoreDeviceDefaultsButton
                  onRestored={() => setRestoreSignal((value) => value + 1)}
                />
              </div>
            ) : null}
          </>
        }
      >
        <div
          key={`${JSON.stringify(search)}:${restoreSignal}`}
          className="min-h-0 flex flex-1 flex-col"
        >
          <SettingsScopeBoundary pathname={location.pathname}>
            <Outlet />
          </SettingsScopeBoundary>
        </div>
      </SettingsDialog>
    </>
  );
}

function SettingsRouteLayout() {
  const rawSearch = Route.useSearch();
  const navigate = Route.useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const project = rawSearch.project;
  const machine = rawSearch.machine;
  const checkout = rawSearch.checkout;
  const search = useMemo(
    () => effectiveSettingsSearch(pathname, { project, machine, checkout }),
    [checkout, machine, pathname, project],
  );
  return (
    <SettingsScopeProvider
      search={search}
      singleEnvironment={SETTINGS_SINGLE_MACHINE_PATHS.has(pathname)}
      onChange={(selected) => {
        const next = settingsSearchAfterScopeChange(pathname, rawSearch, selected);
        // Send every axis so the retain middleware sees an explicit target
        // even when the choice is "all", which is the absence of a key.
        void navigate({
          to: pathname,
          search: () => ({
            project: next.project,
            machine: next.machine,
            checkout: next.checkout,
          }),
          hash: "",
          resetScroll: false,
        });
      }}
    >
      <SettingsContentLayout />
    </SettingsScopeProvider>
  );
}

export const Route = createFileRoute("/settings")({
  validateSearch: validateSettingsRouteSearch,
  search: { middlewares: [retainSettingsScope] },
  beforeLoad: async ({ context, location, search, cause }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }

    // Opening Settings from a project page or thread selects that project.
    redirectSettingsEntry({ location, search, cause });
  },
  component: SettingsRouteLayout,
});
