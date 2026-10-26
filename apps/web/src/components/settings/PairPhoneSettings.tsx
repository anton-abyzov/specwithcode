import {
  AuthStandardClientScopes,
  type AdvertisedEndpoint,
  type AuthEnvironmentScope,
  type AuthPairingCredentialResult,
  type ServerDirectEndpoint,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import { SmartphoneIcon } from "lucide-react";
import { memo, useCallback, useMemo, useState, useEffect, useRef } from "react";

import {
  createServerPairingCredential,
  readPrimaryEnvironmentTarget,
} from "~/environments/primary";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  buildPhonePairingUrl,
  phonePairingCodeState,
  type PhonePairingAddress,
  resolvePhonePairingAddress,
} from "./PairPhone.logic";
import { PhoneSetupDialog, type PhoneSetupCode } from "./PhoneSetupDialog";
import { SettingsDisclosure, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting, type SettingsSearchItemId } from "./settingsSearch";

const PHONE_LINK_LABEL = "iPhone";
const PAIR_PHONE_SETTING: SettingsSearchItemId = "pair-phone";

/** The server this window talks to, which is not always the page's own origin. */
function currentServerOrigin(): string | null {
  try {
    return readPrimaryEnvironmentTarget()?.target.httpBaseUrl ?? window.location.origin;
  } catch {
    return null;
  }
}

function formatClockTime(value: DateTime.Utc): string {
  return new Date(DateTime.toEpochMillis(value)).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

type PairPhoneSettingsProps = {
  /** The endpoint Settings uses for pairing links on this machine. */
  readonly endpoint: AdvertisedEndpoint | null;
  /** Addresses the server reports for itself, for windows without the desktop bridge. */
  readonly serverEndpoints: ReadonlyArray<ServerDirectEndpoint> | undefined;
  readonly canCreateLinks: boolean;
  /** Scopes this window holds; the phone link never asks for more. */
  readonly delegatableScopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly onPairingLinkCreated: (result: AuthPairingCredentialResult) => void;
  /** Whether this window shows the Network access and Tailscale HTTPS rows (desktop app). */
  readonly hasAccessControls: boolean;
  /** Scrolls to the section with Network access and Tailscale HTTPS. */
  readonly onShowAccessSettings: () => void;
  /** Connect is the main way to reach the phone here, so fold direct pairing away. */
  readonly folded?: boolean;
};

/**
 * Prepare the phone route before minting a short-lived pairing credential.
 */
export const PairPhoneSettings = memo(function PairPhoneSettings({
  endpoint,
  serverEndpoints,
  canCreateLinks,
  delegatableScopes,
  onPairingLinkCreated,
  hasAccessControls,
  onShowAccessSettings,
  folded = false,
}: PairPhoneSettingsProps) {
  const address = useMemo(
    () =>
      resolvePhonePairingAddress({
        endpoint,
        serverEndpoints,
        currentOrigin: currentServerOrigin(),
      }),
    [endpoint, serverEndpoints],
  );
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<{
    result: AuthPairingCredentialResult;
    address: PhonePairingAddress;
  } | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const generation = useRef(0);
  const creating = useRef(false);
  useEffect(() => {
    if (!open || created === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [open, created]);
  const codeState =
    created === null
      ? null
      : phonePairingCodeState({
          createdAddress: created.address,
          currentAddress: address,
          expiresAt: DateTime.toEpochMillis(created.result.expiresAt),
          now,
        });
  const code: PhoneSetupCode | null =
    created === null
      ? null
      : codeState === "ready"
        ? {
            status: "ready",
            url: buildPhonePairingUrl(created.address, created.result.credential),
            expiresAt: formatClockTime(created.result.expiresAt),
          }
        : { status: codeState! };
  const changeOpen = (next: boolean) => {
    generation.current += 1;
    setOpen(next);
    setCreated(null);
    setError(null);
    setNow(Date.now());
  };

  const phoneScopes = useMemo(
    () => AuthStandardClientScopes.filter((scope) => delegatableScopes.includes(scope)),
    [delegatableScopes],
  );
  const canPair = canCreateLinks && phoneScopes.length > 0;

  const handlePair = useCallback(async () => {
    if (!canPair || address === null || creating.current) return;
    const attempt = generation.current;
    creating.current = true;
    setIsCreating(true);
    setError(null);
    try {
      const result = await createServerPairingCredential({
        label: PHONE_LINK_LABEL,
        scopes: phoneScopes,
      });
      onPairingLinkCreated(result);
      if (attempt === generation.current) {
        setNow(Date.now());
        setCreated({ result, address });
      }
    } catch (error) {
      if (attempt === generation.current) {
        setError(
          error instanceof Error ? error.message : "Could not create a pairing code. Try again.",
        );
      }
    } finally {
      creating.current = false;
      setIsCreating(false);
    }
  }, [canPair, address, phoneScopes, onPairingLinkCreated]);

  const copy = async (value: string, title: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toastManager.add(stackedThreadToast({ type: "success", title }));
    } catch {
      setError("Could not copy. Select the computer address or scan the code instead.");
    }
  };

  const description = !canPair
    ? "This window cannot create pairing codes. Quit and reopen SpecWithCode so it signs in with full access to this computer."
    : address === null
      ? hasAccessControls
        ? "Your phone needs an address to reach this computer. Set up Tailscale HTTPS for this machine first."
        : "Your phone needs an address to reach this computer. Set up Tailscale Serve for it with `specweave-studio pair --tailscale`, or open these settings in the SpecWithCode desktop app."
      : `Scan a code with the SpecWithCode app on your iPhone. It connects to ${address.httpBaseUrl.replace(/\/$/u, "")}.`;

  const content = (
    <>
      <SettingsRow
        title="Pair a phone"
        description={description}
        control={
          <Button
            size="sm"
            variant={folded ? "outline" : "default"}
            disabled={!canPair}
            onClick={() => changeOpen(true)}
          >
            Pair a phone
          </Button>
        }
      />
      <PhoneSetupDialog
        open={open}
        onOpenChange={changeOpen}
        address={address}
        code={code}
        canPair={canPair}
        isCreating={isCreating}
        error={error}
        hasAccessControls={hasAccessControls}
        onShowAccessSettings={() => {
          changeOpen(false);
          onShowAccessSettings();
        }}
        onGenerate={() => void handlePair()}
        onCopyAddress={() => {
          if (address !== null) void copy(address.httpBaseUrl, "Computer address copied");
        }}
        onCopyCode={() => {
          if (
            created !== null &&
            canPair &&
            phonePairingCodeState({
              createdAddress: created.address,
              currentAddress: address,
              expiresAt: DateTime.toEpochMillis(created.result.expiresAt),
              now: Date.now(),
            }) === "ready"
          ) {
            void copy(
              buildPhonePairingUrl(created.address, created.result.credential),
              "Pairing link copied",
            );
          }
        }}
      />
    </>
  );

  if (folded) {
    return (
      <SettingsDisclosure
        {...searchableSetting(PAIR_PHONE_SETTING)}
        title="Pair over Tailscale or your network"
      >
        {content}
      </SettingsDisclosure>
    );
  }

  return (
    <SettingsSection
      {...searchableSetting(PAIR_PHONE_SETTING)}
      title="Phone"
      icon={<SmartphoneIcon aria-hidden className="size-4" />}
    >
      {content}
    </SettingsSection>
  );
});
