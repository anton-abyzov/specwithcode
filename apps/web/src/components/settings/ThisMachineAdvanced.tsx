/**
 * The folded "Advanced" part of Settings > Machines, and the rows of it that
 * stand on their own: SpecWithCode Connect for this machine, activity for phone
 * notifications and held webhooks. The page (MachinesSettings) sets the order;
 * ConnectionsSettings still builds the rows that share its network state.
 */
import { AuthRelayWriteScope } from "@specweave-studio/contracts";
import { type ReactNode, useState } from "react";

import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { useCloudLinkController } from "~/cloud/useCloudLinkController";
import { useRememberConnectChoice } from "~/cloud/useRememberConnectChoice";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { readEnvironmentScope } from "~/state/session";

import { useTx } from "../../i18n";
import { teamRulesReachLock } from "../../teamRules/teamRulesView";
import { useTeamRules } from "../../teamRules/useTeamRules";
import { useStudioConnectAuthPrompt } from "../clerk/useStudioConnectAuthPrompt";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { isPhoneConnectShown } from "./PhoneConnectSettings";
import { SettingsDisclosure, SettingsRow, TeamRulesLabel } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { TeamRulesInert } from "./TeamRulesLock";

/** The pieces of Settings > Machines that ConnectionsSettings builds, for the page to order. */
export interface MachinesPageParts {
  /** The other machines this app knows of, as cards. */
  readonly otherMachines: ReactNode;
  /**
   * Pairing a phone over the person's own network: the quiet row for the phone
   * card where that card is shown, else a section of its own. Null without a machine.
   */
  readonly pairPhone: ReactNode;
  /** This machine's rows, the signed-in browsers and apps, and the dialogs they open. */
  readonly thisMachine: ReactNode;
  /** Connections saved by hand, with the button that adds one. */
  readonly savedConnections: ReactNode;
  /** Which machine takes new work, and which answers GitHub. */
  readonly routing: ReactNode;
}

/** The id settings search and "show the switches" buttons scroll to; opening it is automatic. */
export const MACHINES_ADVANCED_ID = "machines-advanced";

/**
 * Everything on the page that most people never change, folded. It stays
 * mounted while closed, so settings search and the buttons that point at a row
 * inside can open it.
 */
export function ThisMachineAdvanced({ children }: { readonly children: ReactNode }) {
  return (
    <SettingsDisclosure
      id={MACHINES_ADVANCED_ID}
      title="Advanced: run agents on this machine, network access, Tailscale, signed-in browsers and apps, saved connections"
    >
      <div className="flex flex-col gap-6 px-3 py-4 sm:px-4">{children}</div>
    </SettingsDisclosure>
  );
}

function CloudLinkSwitch({
  checked,
  disabled,
  disabledReason,
  onCheckedChange,
  ariaLabel = "Enable SpecWithCode Connect",
}: {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly disabledReason: string | null;
  readonly onCheckedChange?: (enabled: boolean) => void;
  readonly ariaLabel?: string;
}) {
  const control = (
    <Switch
      aria-label={ariaLabel}
      checked={checked}
      disabled={disabled}
      {...(onCheckedChange ? { onCheckedChange } : {})}
    />
  );
  return disabledReason ? (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex">{control}</span>} />
      <TooltipPopup side="top">{disabledReason}</TooltipPopup>
    </Tooltip>
  ) : (
    control
  );
}

function ConfiguredCloudLinkRow({ canManageRelay }: { readonly canManageRelay: boolean }) {
  const tx = useTx();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { summary: teamRules } = useTeamRules(primaryEnvironmentId);
  const connectLock = teamRulesReachLock(teamRules, "connect");
  const webhooksLock = teamRulesReachLock(teamRules, "webhooks");
  const connectLockLabel = connectLock ? (
    <TeamRulesLabel>{connectLock.setBy}</TeamRulesLabel>
  ) : null;
  const {
    isSignedIn,
    linkState: primaryCloudLinkState,
    managedTunnelActive,
    publishAgentActivity,
    holdWebhooksWhileOffline,
    operationError,
    reconcileCloudState,
  } = useCloudLinkController();
  const { openAuthPrompt } = useStudioConnectAuthPrompt();
  const rememberConnectChoice = useRememberConnectChoice();
  const [isUpdating, setIsUpdating] = useState(false);
  const [isUpdatingPreference, setIsUpdatingPreference] = useState(false);

  const disabledReason = !isSignedIn
    ? "Sign in to SpecWithCode Connect to change this."
    : !canManageRelay
      ? "Your session does not have permission to manage SpecWithCode Connect access."
      : null;
  const isBusy = isUpdating || isUpdatingPreference;

  const updateManagedTunnel = async (enabled: boolean) => {
    if (
      primaryEnvironmentId === null ||
      !readEnvironmentScope(primaryEnvironmentId, AuthRelayWriteScope)
    )
      return;
    setIsUpdating(true);
    const ok = await reconcileCloudState({ managedTunnel: enabled, publish: publishAgentActivity });
    if (ok) {
      // Off here is the owner's choice: a later sign-in does not turn it back on.
      rememberConnectChoice(enabled);
      // Turning the tunnel off while publishing stays on downgrades the link
      // rather than removing it — say so instead of claiming an unlink.
      toastManager.add({
        type: "success",
        title: enabled
          ? "SpecWithCode Connect linked"
          : publishAgentActivity
            ? "SpecWithCode Connect turned off"
            : "SpecWithCode Connect unlinked",
        description: enabled
          ? "Your other devices can reach this machine through SpecWithCode Connect."
          : publishAgentActivity
            ? "Your other devices can no longer reach this machine. Activity for phone notifications stays on."
            : "Your other devices can no longer reach this machine through SpecWithCode Connect.",
      });
    }
    setIsUpdating(false);
  };

  const updatePublishAgentActivity = async (enabled: boolean) => {
    if (
      primaryEnvironmentId === null ||
      !readEnvironmentScope(primaryEnvironmentId, AuthRelayWriteScope)
    )
      return;
    setIsUpdatingPreference(true);
    const ok = await reconcileCloudState({ managedTunnel: managedTunnelActive, publish: enabled });
    if (ok) {
      toastManager.add({
        type: "success",
        title: enabled
          ? "Activity for phone notifications is on"
          : "Activity for phone notifications is off",
        description: enabled
          ? "This machine sends agent activity to your phone's notifications."
          : "This machine no longer sends agent activity to your phone.",
      });
    }
    setIsUpdatingPreference(false);
  };

  const updateHoldWebhooks = async (enabled: boolean) => {
    setIsUpdatingPreference(true);
    const ok = await reconcileCloudState({
      managedTunnel: managedTunnelActive,
      publish: publishAgentActivity,
      holdWebhooksWhileOffline: enabled,
    });
    if (ok) {
      toastManager.add({
        type: "success",
        title: enabled ? "Webhooks held while offline" : "Webhooks no longer held",
        description: enabled
          ? "SpecWithCode Connect keeps webhook requests for up to 24 hours while this machine is offline."
          : "Requests to this machine now fail while it is offline. Anything already held is still delivered.",
      });
    }
    setIsUpdatingPreference(false);
  };

  return (
    <>
      {/* On desktop, the phone card signs in and links this machine in one step. */}
      {isSignedIn === false && !isPhoneConnectShown() ? (
        <SettingsRow
          title="SpecWithCode Connect account"
          description={
            connectLock?.message ??
            "Optional. Sign in to reach your machines from anywhere and to change the settings below."
          }
          status={connectLockLabel ?? undefined}
          control={
            <TeamRulesInert lock={connectLock}>
              <Button size="sm" variant="outline" onClick={openAuthPrompt}>
                {tx("Sign in")}
              </Button>
            </TeamRulesInert>
          }
        />
      ) : null}
      {window.desktopBridge ? (
        <SettingsRow
          title={searchableSetting("studio-connect").title}
          description={
            connectLock?.message ??
            (managedTunnelActive
              ? "Your phone and your other machines reach this machine from anywhere. Turn off and they can no longer reach it this way."
              : "Turn on to reach this machine from your phone and your other machines, from anywhere.")
          }
          status={connectLockLabel ?? operationError ?? primaryCloudLinkState.error}
          control={
            <TeamRulesInert lock={connectLock}>
              <CloudLinkSwitch
                checked={managedTunnelActive}
                disabled={
                  !canManageRelay ||
                  !isSignedIn ||
                  primaryCloudLinkState.data === null ||
                  primaryCloudLinkState.isPending ||
                  isBusy
                }
                disabledReason={disabledReason}
                onCheckedChange={(enabled) => void updateManagedTunnel(enabled)}
              />
            </TeamRulesInert>
          }
        />
      ) : null}
      <SettingsRow
        title={searchableSetting("publish-agent-activity").title}
        description={
          connectLock?.message ??
          // The switch needs the account: notifications go to the phones signed in to it.
          (isSignedIn
            ? tx(
                "Send agent activity to your phone's notifications and Live Activities, even while SpecWithCode Connect is off for this machine. Turn off and your phone shows no activity from this machine.",
              )
            : tx(
                "Sign in to SpecWithCode Connect to change this. Notifications go to the phones signed in to your account.",
              ))
        }
        status={connectLockLabel ?? undefined}
        control={
          <TeamRulesInert lock={connectLock}>
            <CloudLinkSwitch
              ariaLabel={tx("Send activity for phone notifications")}
              checked={publishAgentActivity}
              disabled={
                !canManageRelay ||
                !isSignedIn ||
                primaryCloudLinkState.data === null ||
                primaryCloudLinkState.isPending ||
                isBusy
              }
              disabledReason={disabledReason}
              onCheckedChange={(enabled) => void updatePublishAgentActivity(enabled)}
            />
          </TeamRulesInert>
        }
      />
      {managedTunnelActive ? (
        <SettingsRow
          title={searchableSetting("hold-webhooks-while-offline").title}
          description={
            webhooksLock?.message ??
            "Keep webhook requests for up to 24 hours while this machine is offline, then deliver them. Turn off and SpecWithCode Connect only forwards requests and stores nothing."
          }
          status={webhooksLock ? <TeamRulesLabel>{webhooksLock.setBy}</TeamRulesLabel> : undefined}
          control={
            <TeamRulesInert lock={webhooksLock}>
              <CloudLinkSwitch
                ariaLabel="Hold webhook requests while this machine is offline"
                checked={holdWebhooksWhileOffline}
                disabled={
                  !canManageRelay || !isSignedIn || primaryCloudLinkState.isPending || isBusy
                }
                disabledReason={disabledReason}
                onCheckedChange={(enabled) => void updateHoldWebhooks(enabled)}
              />
            </TeamRulesInert>
          }
        />
      ) : null}
    </>
  );
}

export function CloudLinkRow({
  canReadRelay,
  canManageRelay,
}: {
  readonly canReadRelay: boolean;
  readonly canManageRelay: boolean;
}) {
  const { summary: teamRules } = useTeamRules(usePrimaryEnvironmentId());
  if (!hasCloudPublicConfig()) return null;
  if (!canReadRelay) {
    const lock = teamRulesReachLock(teamRules, "connect");
    return (
      <SettingsRow
        title="SpecWithCode Connect"
        description={
          lock?.message ??
          "To change these settings, pair this connection with both View Connect and Manage Connect permissions."
        }
        status={lock ? <TeamRulesLabel>{lock.setBy}</TeamRulesLabel> : undefined}
      />
    );
  }
  return <ConfiguredCloudLinkRow canManageRelay={canManageRelay} />;
}
