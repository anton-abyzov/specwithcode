import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import {
  ActivityIcon,
  ChartNoAxesColumnIcon,
  ChevronsUpDownIcon,
  LogInIcon,
  LogOutIcon,
  MonitorSmartphoneIcon,
  NetworkIcon,
  SettingsIcon,
  UserRoundCogIcon,
} from "lucide-react";
import { useCallback } from "react";

import { isElectron } from "../../env";
import { shortcutLabelForCommand } from "../../keybindings";
import { cn } from "../../lib/utils";
import { usePrimaryEnvironment, usePullRequestsSupported } from "../../state/environments";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { ADD_DEVICE_OR_MACHINE_ANCHOR } from "../settings/AddDeviceWithCodeRow";
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
import { accountMenuPresentation, type ConnectAccount } from "./accountMenuModel";
import { accountInitial } from "./signInAddress";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export interface ConnectAccountActions {
  readonly account: ConnectAccount;
  readonly onSignIn: () => void;
  /** Null until the Clerk account page can open. */
  readonly onManage: (() => void) | null;
  readonly onSignOut: () => void;
}

export type AccountMenuDestination = "/settings" | "/usage" | "/status" | "/settings/connections";

/** The button and its menu, with everything it shows passed in. */
export function AccountMenuView({
  compact,
  machine,
  connect,
  usageShortcut,
  pullRequestsSupported,
  onNavigate,
  onOpenPullRequests,
  onAddDevice,
}: {
  readonly compact: boolean;
  readonly machine: string;
  readonly connect: ConnectAccountActions | null;
  readonly usageShortcut: string | null;
  readonly pullRequestsSupported: boolean;
  readonly onNavigate: (to: AccountMenuDestination) => void;
  readonly onOpenPullRequests: () => void;
  /** Opens Settings > Machines, where every way to add a device or a machine lives. */
  readonly onAddDevice: () => void;
}) {
  const { name, header, signIn } = accountMenuPresentation(
    connect?.account ?? { status: "unavailable" },
    machine,
  );
  const signedIn = connect?.account.status === "signedIn";

  const avatar = (
    <span
      aria-hidden="true"
      className="flex size-6 shrink-0 items-center justify-center rounded-full bg-sidebar-control-surface font-medium text-2xs text-sidebar-foreground ring-1 ring-sidebar-border"
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
        <SidebarMenuButton aria-label={`Account: ${name}`}>
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
            <MenuGroupLabel title={header}>
              <span className="block truncate">{header}</span>
            </MenuGroupLabel>
            {signIn && connect ? (
              <MenuItem onClick={connect.onSignIn} title={signIn.hint}>
                <LogInIcon />
                {signIn.label}
              </MenuItem>
            ) : null}
            <MenuItem onClick={() => onNavigate("/settings")}>
              <SettingsIcon />
              Settings
              {isElectron && IS_MAC ? <MenuShortcut>⌘,</MenuShortcut> : null}
            </MenuItem>
            <MenuItem onClick={() => onNavigate("/usage")}>
              <ChartNoAxesColumnIcon />
              Usage
              {usageShortcut ? <MenuShortcut>{usageShortcut}</MenuShortcut> : null}
            </MenuItem>
            <MenuItem onClick={() => onNavigate("/status")}>
              <ActivityIcon />
              Status
            </MenuItem>
            {pullRequestsSupported ? (
              <MenuItem onClick={onOpenPullRequests}>
                <PullRequestGlyph.pullRequest />
                Code Review
              </MenuItem>
            ) : null}
          </MenuGroup>
          <MenuSeparator />
          <MenuGroup>
            <MenuItem onClick={onAddDevice}>
              <MonitorSmartphoneIcon />
              Add a device or machine
            </MenuItem>
            <MenuItem onClick={() => onNavigate("/settings/connections")}>
              <NetworkIcon />
              Machines and connections
            </MenuItem>
          </MenuGroup>
          {signedIn && connect ? (
            <>
              <MenuSeparator />
              <MenuGroup>
                {connect.onManage ? (
                  <MenuItem onClick={connect.onManage}>
                    <UserRoundCogIcon />
                    Manage account
                  </MenuItem>
                ) : null}
                <MenuItem onClick={connect.onSignOut}>
                  <LogOutIcon />
                  Sign out
                </MenuItem>
              </MenuGroup>
            </>
          ) : null}
        </MenuPopup>
      </Menu>
    </SidebarMenuItem>
  );
}

/**
 * One account button in place of the footer's row of icons, like Claude's:
 * Settings, Usage and Pull Requests live in its menu, along with the way to
 * Settings > Machines for adding a device or a machine. On Settings, Usage or Pull Requests it shrinks to its avatar beside
 * the Back button. `connect` is null in builds without SpecWithCode Connect.
 */
export function AccountMenu({
  compact,
  connect,
}: {
  readonly compact: boolean;
  readonly connect: ConnectAccountActions | null;
}) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const pullRequestsSupported = usePullRequestsSupported();
  const primary = usePrimaryEnvironment();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);

  const go = useCallback(
    (to: AccountMenuDestination) => {
      if (isMobile) setOpenMobile(false);
      void navigate({ to });
    },
    [isMobile, navigate, setOpenMobile],
  );
  const openPullRequests = useCallback(() => {
    if (isMobile) setOpenMobile(false);
    void navigate({ to: "/pull-requests", search: readPullRequestListPreferences() });
  }, [isMobile, navigate, setOpenMobile]);

  // The join card: one click for a machine on the same account, with the join
  // line and the code path folded below it.
  const addDeviceOrMachine = useCallback(() => {
    if (isMobile) setOpenMobile(false);
    void navigate({ to: "/settings/machines", hash: ADD_DEVICE_OR_MACHINE_ANCHOR });
  }, [isMobile, navigate, setOpenMobile]);

  return (
    <AccountMenuView
      compact={compact}
      machine={primary?.label ?? "This machine"}
      connect={connect}
      usageShortcut={shortcutLabelForCommand(keybindings, "usage.open")}
      pullRequestsSupported={pullRequestsSupported}
      onNavigate={go}
      onOpenPullRequests={openPullRequests}
      onAddDevice={addDeviceOrMachine}
    />
  );
}
