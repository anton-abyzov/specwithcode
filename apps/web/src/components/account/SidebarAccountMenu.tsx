import { useAtomValue } from "@effect/atom-react";
import { AuthAccessWriteScope, AuthOrchestrationReadScope } from "@specweave-studio/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ChartNoAxesColumnIcon,
  ChevronsUpDownIcon,
  MonitorSmartphoneIcon,
  NetworkIcon,
  SettingsIcon,
} from "lucide-react";
import { memo, useCallback, useState } from "react";

import { isElectron } from "../../env";
import { shortcutLabelForCommand } from "../../keybindings";
import { cn } from "../../lib/utils";
import { useServerConfigs } from "../../state/entities";
import { usePrimaryEnvironment, usePullRequestsSupported } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { primaryServerKeybindingsAtom, serverEnvironment } from "../../state/server";
import { useEnvironmentAcceptsBrowserSignIn, useEnvironmentScope } from "../../state/session";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
} from "../ui/menu";
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { accountInitial } from "./signInAddress";
import { SignInAnotherDeviceDialog } from "./SignInAnotherDeviceDialog";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Who this window is signed in as: the connected Google account, else the machine. */
function useAccountIdentity() {
  const primary = usePrimaryEnvironment();
  const environmentId = primary?.environmentId ?? null;
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const configs = useServerConfigs();
  const supported =
    environmentId !== null &&
    configs.get(environmentId)?.environment.capabilities.googleAccount === true;
  const google = useEnvironmentQuery(
    environmentId === null || !canRead || !supported
      ? null
      : serverEnvironment.googleAccountStatus({ environmentId, input: {} }),
  );
  const email = google.data?.email ?? null;
  const machine = primary?.label ?? "This machine";
  return { email, machine, name: email ?? machine };
}

/**
 * One account button in place of the footer's row of icons, like Claude's:
 * Settings, Usage and Pull Requests live in its menu, along with signing in
 * on another device. On Settings, Usage or Pull Requests it shrinks to its
 * avatar beside the Back button.
 */
export const SidebarAccountMenu = memo(function SidebarAccountMenu({
  compact = false,
}: {
  readonly compact?: boolean;
}) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const pullRequestsSupported = usePullRequestsSupported();
  const primary = usePrimaryEnvironment();
  const canApproveDevices = useEnvironmentScope(
    primary?.environmentId ?? null,
    AuthAccessWriteScope,
  );
  const acceptsBrowsers = useEnvironmentAcceptsBrowserSignIn(primary?.environmentId ?? null);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const usageShortcut = shortcutLabelForCommand(keybindings, "usage.open");
  const { email, machine, name } = useAccountIdentity();
  const [deviceDialogOpen, setDeviceDialogOpen] = useState(false);

  const go = useCallback(
    (to: "/settings" | "/usage" | "/settings/connections") => {
      if (isMobile) setOpenMobile(false);
      void navigate({ to });
    },
    [isMobile, navigate, setOpenMobile],
  );
  const openPullRequests = useCallback(() => {
    if (isMobile) setOpenMobile(false);
    void navigate({ to: "/pull-requests", search: readPullRequestListPreferences() });
  }, [isMobile, navigate, setOpenMobile]);

  const avatar = (
    <span
      aria-hidden="true"
      className="flex size-6 shrink-0 items-center justify-center rounded-full bg-sidebar-control-surface font-medium text-[11px] text-sidebar-foreground ring-1 ring-sidebar-border"
    >
      {accountInitial(name)}
    </span>
  );

  const trigger = compact ? (
    <MenuTrigger
      render={
        <SidebarMenuButton aria-label={`Account: ${name}`} size="icon">
          {avatar}
        </SidebarMenuButton>
      }
    />
  ) : (
    <MenuTrigger
      render={
        <SidebarMenuButton aria-label={`Account: ${name}`} className="gap-2">
          {avatar}
          <span className="min-w-0 flex-1 truncate text-sidebar-foreground">{name}</span>
          <ChevronsUpDownIcon className="ms-auto size-3.5! opacity-70" />
        </SidebarMenuButton>
      }
    />
  );

  return (
    <SidebarMenuItem className={cn(compact ? "shrink-0" : "min-w-0 flex-1")}>
      <Menu>
        {compact ? (
          <Tooltip>
            <TooltipTrigger render={trigger} />
            <TooltipPopup side="top">Account and settings</TooltipPopup>
          </Tooltip>
        ) : (
          trigger
        )}
        <MenuPopup align="start" className="min-w-64" side="top" sideOffset={6}>
          <MenuGroup>
            <MenuGroupLabel className="truncate" title={email ? `${email} on ${machine}` : machine}>
              {email ? `${email} · ${machine}` : `Signed in to ${machine}`}
            </MenuGroupLabel>
            <MenuItem onClick={() => go("/settings")}>
              <SettingsIcon />
              Settings
              {isElectron && IS_MAC ? <MenuShortcut>⌘,</MenuShortcut> : null}
            </MenuItem>
            <MenuItem onClick={() => go("/usage")}>
              <ChartNoAxesColumnIcon />
              Usage
              {usageShortcut ? <MenuShortcut>{usageShortcut}</MenuShortcut> : null}
            </MenuItem>
            {pullRequestsSupported ? (
              <MenuItem onClick={openPullRequests}>
                <PullRequestGlyph.pullRequest />
                Pull requests
              </MenuItem>
            ) : null}
          </MenuGroup>
          <MenuSeparator />
          <MenuGroup>
            {canApproveDevices ? (
              <MenuItem onClick={() => setDeviceDialogOpen(true)}>
                <MonitorSmartphoneIcon />
                Sign in on another device
              </MenuItem>
            ) : null}
            <MenuItem onClick={() => go("/settings/connections")}>
              <NetworkIcon />
              Machines and connections
            </MenuItem>
          </MenuGroup>
        </MenuPopup>
      </Menu>
      {canApproveDevices ? (
        <SignInAnotherDeviceDialog
          acceptsBrowsers={acceptsBrowsers}
          open={deviceDialogOpen}
          onOpenChange={setDeviceDialogOpen}
        />
      ) : null}
    </SidebarMenuItem>
  );
});
