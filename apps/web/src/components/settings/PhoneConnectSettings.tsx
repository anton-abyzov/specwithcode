import { useTx } from "../../i18n";
import { useAuth } from "@clerk/react";
import { AuthRelayWriteScope } from "@specweave-studio/contracts";
import { SmartphoneIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { useCloudLinkController } from "~/cloud/useCloudLinkController";
import { useRememberConnectChoice } from "~/cloud/useRememberConnectChoice";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentScope } from "~/state/session";
import { isMacPlatform } from "~/lib/utils";
import { teamRulesReachLock } from "~/teamRules/teamRulesView";
import { useTeamRules } from "~/teamRules/useTeamRules";
import { useStudioConnectAuthPrompt } from "../clerk/useStudioConnectAuthPrompt";
import { Button } from "../ui/button";
import {
  PHONE_CONNECT_PENDING_KEY,
  resolvePhoneConnectStep,
  shouldAutoTurnOn,
  shouldClearPending,
} from "./PhoneConnect.logic";
import { PhoneDevicesSettings } from "./PhoneDevicesSettings";
import { SettingsRow, SettingsSection, TeamRulesLabel } from "./settingsLayout";
import { TeamRulesInert } from "./TeamRulesLock";

function readPending(): boolean {
  try {
    return window.sessionStorage.getItem(PHONE_CONNECT_PENDING_KEY) === "1";
  } catch {
    return false;
  }
}

function writePending(pending: boolean): void {
  try {
    if (pending) window.sessionStorage.setItem(PHONE_CONNECT_PENDING_KEY, "1");
    else window.sessionStorage.removeItem(PHONE_CONNECT_PENDING_KEY);
  } catch {
    // Storage can be unavailable; the person then clicks the second button.
  }
}

/** Whether this window shows the Connect card (a build with Connect, in the desktop app). */
export function isPhoneConnectShown(): boolean {
  return hasCloudPublicConfig() && window.desktopBridge !== undefined;
}

/**
 * The one-click way to reach this computer from the iPhone: sign in, and it
 * links itself to SpecWithCode Connect with its own tunnel. Direct pairing
 * (Tailscale or the same network) stays below as a folded advanced option.
 */
export function PhoneConnectSettings() {
  if (!isPhoneConnectShown()) return null;
  return <ConfiguredPhoneConnectSettings />;
}

function ConfiguredPhoneConnectSettings() {
  const tx = useTx();
  const { isLoaded } = useAuth();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const canManageRelay = useEnvironmentScope(primaryEnvironmentId, AuthRelayWriteScope);
  const { summary: teamRules } = useTeamRules(primaryEnvironmentId);
  // This card is a phone reaching the machine over Connect, so either rule stops it.
  const teamRulesLock =
    teamRulesReachLock(teamRules, "phones") ?? teamRulesReachLock(teamRules, "connect");
  const {
    isSignedIn,
    userId: connectAccount,
    linkState,
    managedTunnelActive,
    publishAgentActivity,
    operationError,
    reconcileCloudState,
  } = useCloudLinkController();
  const { authPrompt, openAuthPrompt } = useStudioConnectAuthPrompt();
  const rememberConnectChoice = useRememberConnectChoice(connectAccount);
  const [busy, setBusy] = useState(false);

  const step = resolvePhoneConnectStep({
    configured: true,
    isDesktop: true,
    authLoaded: isLoaded,
    signedIn: isSignedIn === true,
    canManageRelay,
    linkStateKnown: linkState.data !== null && !linkState.isPending,
    managedTunnelActive,
  });

  const turnOn = async () => {
    setBusy(true);
    writePending(false);
    // Keep an existing agent-activity choice; a first link publishes so the phone gets alerts.
    const ok = await reconcileCloudState({
      managedTunnel: true,
      publish: publishAgentActivity || !managedTunnelActive,
    });
    // Turned on from here: an earlier off no longer holds a sign-in back.
    if (ok) rememberConnectChoice(true);
    setBusy(false);
  };

  useEffect(() => {
    if (busy || teamRulesLock !== null) return;
    if (shouldAutoTurnOn(step, readPending())) {
      void turnOn();
    } else if (shouldClearPending(step)) {
      writePending(false);
    }
    // turnOn is recreated each render; the step change is the trigger.
  }, [step, busy, teamRulesLock]);

  if (step === "hidden") return null;

  // Linux and Windows desktops run this card too: name the machine they are on.
  const computer = isMacPlatform(navigator.platform) ? "Mac" : "computer";
  const row = (() => {
    if (teamRulesLock !== null) {
      return (
        <SettingsRow
          title={`Make this ${computer} reachable from your iPhone`}
          description={teamRulesLock.message}
          status={<TeamRulesLabel>{teamRulesLock.setBy}</TeamRulesLabel>}
          control={
            <TeamRulesInert lock={teamRulesLock}>
              <Button size="sm">{tx("Turn on")}</Button>
            </TeamRulesInert>
          }
        />
      );
    }
    switch (step) {
      case "loading":
        // A failed read leaves the link state unknown; show why instead of waiting forever.
        if (linkState.error && !linkState.isPending) {
          return (
            <SettingsRow
              title="Could not check SpecWithCode Connect"
              description="Try again in a moment."
              status={linkState.error}
              control={
                <Button size="sm" variant="outline" onClick={() => linkState.refresh()}>
                  {tx("Try again")}
                </Button>
              }
            />
          );
        }
        return <SettingsRow title="Checking SpecWithCode Connect" description="One moment." />;
      case "sign-in":
        return (
          <SettingsRow
            title={`Sign in to reach this ${computer} from your iPhone`}
            description="Then sign in with the same account in the iPhone app, on each iPhone you use. No Tailscale, VPN or open ports."
            control={
              <Button
                size="sm"
                onClick={() => {
                  writePending(true);
                  openAuthPrompt();
                }}
              >
                {tx("Sign in")}
              </Button>
            }
          />
        );
      case "no-permission":
        return (
          <SettingsRow
            title="This window cannot turn on SpecWithCode Connect"
            description={`Open SpecWithCode on this ${computer} itself, or pair this connection with Manage relay permission.`}
          />
        );
      case "turn-on":
        return (
          <SettingsRow
            title={`Make this ${computer} reachable from your iPhone`}
            description={`This ${computer} gets a private address through SpecWithCode Connect that only your account can use.`}
            status={operationError ?? linkState.error}
            control={
              <Button size="sm" disabled={busy} onClick={() => void turnOn()}>
                {busy ? tx("Turning on…") : tx("Turn on")}
              </Button>
            }
          />
        );
      case "ready":
        return (
          <SettingsRow
            title={`This ${computer} is ready for your iPhone`}
            description={`Open SpecWithCode on the iPhone and sign in with the same account. This ${computer} appears in its list. Add another iPhone the same way.`}
            status={operationError ?? linkState.error}
          />
        );
    }
  })();

  return (
    <SettingsSection
      id="phone-connect"
      title="Your phones"
      icon={<SmartphoneIcon className="size-4" />}
    >
      {row}
      {authPrompt}
      {isSignedIn === true ? <PhoneDevicesSettings /> : null}
    </SettingsSection>
  );
}
