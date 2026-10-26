import { useAuth } from "@clerk/react";
import { AuthRelayWriteScope } from "@specweave-studio/contracts";
import { SmartphoneIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { useCloudLinkController } from "~/cloud/useCloudLinkController";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentScope } from "~/state/session";
import { useStudioConnectAuthPrompt } from "../clerk/useStudioConnectAuthPrompt";
import { Button } from "../ui/button";
import {
  PHONE_CONNECT_PENDING_KEY,
  resolvePhoneConnectStep,
  shouldAutoTurnOn,
  shouldClearPending,
} from "./PhoneConnect.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";

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
 * The one-click way to reach this Mac from the iPhone: sign in, and the Mac
 * links itself to SpecWithCode Connect with its own tunnel. Direct pairing
 * (Tailscale or the same network) stays below as a folded advanced option.
 */
export function PhoneConnectSettings() {
  if (!isPhoneConnectShown()) return null;
  return <ConfiguredPhoneConnectSettings />;
}

function ConfiguredPhoneConnectSettings() {
  const { isLoaded } = useAuth();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const canManageRelay = useEnvironmentScope(primaryEnvironmentId, AuthRelayWriteScope);
  const {
    isSignedIn,
    linkState,
    managedTunnelActive,
    publishAgentActivity,
    operationError,
    reconcileCloudState,
  } = useCloudLinkController();
  const { authPrompt, openAuthPrompt } = useStudioConnectAuthPrompt();
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
    await reconcileCloudState({
      managedTunnel: true,
      publish: publishAgentActivity || !managedTunnelActive,
    });
    setBusy(false);
  };

  useEffect(() => {
    if (busy) return;
    if (shouldAutoTurnOn(step, readPending())) {
      void turnOn();
    } else if (shouldClearPending(step)) {
      writePending(false);
    }
    // turnOn is recreated each render; the step change is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, busy]);

  if (step === "hidden") return null;

  const row = (() => {
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
                  Try again
                </Button>
              }
            />
          );
        }
        return <SettingsRow title="Checking SpecWithCode Connect" description="One moment." />;
      case "sign-in":
        return (
          <SettingsRow
            title="Sign in to reach this Mac from your iPhone"
            description="Use the same account on the iPhone app. No Tailscale, VPN or open ports."
            control={
              <Button
                size="sm"
                onClick={() => {
                  writePending(true);
                  openAuthPrompt();
                }}
              >
                Sign in
              </Button>
            }
          />
        );
      case "no-permission":
        return (
          <SettingsRow
            title="This window cannot turn on SpecWithCode Connect"
            description="Open SpecWithCode on this Mac itself, or pair this connection with Manage relay permission."
          />
        );
      case "turn-on":
        return (
          <SettingsRow
            title="Make this Mac reachable from your iPhone"
            description="This Mac gets a private address through SpecWithCode Connect that only your account can use."
            status={operationError ?? linkState.error}
            control={
              <Button size="sm" disabled={busy} onClick={() => void turnOn()}>
                {busy ? "Turning on…" : "Turn on"}
              </Button>
            }
          />
        );
      case "ready":
        return (
          <SettingsRow
            title="This Mac is ready for your iPhone"
            description="Open SpecWithCode on the iPhone and sign in with the same account. This Mac appears in its list."
            status={operationError ?? linkState.error}
          />
        );
    }
  })();

  return (
    <SettingsSection
      title="Use SpecWithCode on your phone"
      icon={<SmartphoneIcon className="size-4" />}
    >
      {row}
      {authPrompt}
    </SettingsSection>
  );
}
