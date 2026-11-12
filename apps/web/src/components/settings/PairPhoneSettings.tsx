import { useTx } from "../../i18n";
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
import type { TeamRulesLock } from "../../teamRules/teamRulesView";
import {
  SettingsRow,
  SettingsSearchTarget,
  SettingsSection,
  TeamRulesLabel,
} from "./settingsLayout";
import { TeamRulesInert } from "./TeamRulesLock";
import { searchableSetting, type SettingsSearchItemId } from "./settingsSearch";

const PHONE_LINK_LABEL = "Phone";
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
  /** Turns Network access on, where this window can. The dialog offers it as a button. */
  readonly onTurnOnNetworkAccess?: (() => void) | undefined;
  /**
   * Connect is the way to add a phone here, so this is one quiet row,
   * "Cannot use Connect? Pair over your own network", never a primary button.
   */
  readonly folded?: boolean;
  /** Set when this machine's rules refuse new phones. */
  readonly teamRulesLock?: TeamRulesLock | null;
};

/**
 * Pairing a phone over the person's own network, the alternative to
 * SpecWithCode Connect: prepare the phone's route to this computer, then mint
 * a short-lived pairing credential. Its dialog opens straight at those steps.
 */
export const PairPhoneSettings = memo(function PairPhoneSettings({
  endpoint,
  serverEndpoints,
  canCreateLinks,
  delegatableScopes,
  onPairingLinkCreated,
  hasAccessControls,
  onShowAccessSettings,
  onTurnOnNetworkAccess,
  folded = false,
  teamRulesLock = null,
}: PairPhoneSettingsProps) {
  const tx = useTx();
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

  const cannotPair = tx(
    "This window cannot create pairing codes. Quit and reopen SpecWithCode so it signs in with full access to this computer.",
  );
  const description = !canPair
    ? cannotPair
    : address === null
      ? hasAccessControls
        ? tx(
            "To pair over your own network, your phone needs an address for this computer. Turn on Network access or Tailscale HTTPS first.",
          )
        : tx(
            "To pair over your own network, open these settings in the SpecWithCode desktop app on this computer and turn on Network access or Tailscale HTTPS.",
          )
      : tx("Scan a one-time code with the SpecWithCode app on your phone. It connects to {url}.", {
          url: address.httpBaseUrl.replace(/\/$/u, ""),
        });

  const content = (
    <>
      {folded ? (
        <div
          data-pair-phone-row
          className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 sm:px-4"
        >
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">
            {teamRulesLock?.message ??
              (canPair ? tx("Cannot use Connect? Pair over your own network.") : cannotPair)}
          </p>
          {teamRulesLock ? <TeamRulesLabel>{teamRulesLock.setBy}</TeamRulesLabel> : null}
          <TeamRulesInert lock={teamRulesLock}>
            <Button size="xs" variant="ghost" disabled={!canPair} onClick={() => changeOpen(true)}>
              {tx("Pair with a private QR code")}
            </Button>
          </TeamRulesInert>
        </div>
      ) : (
        <SettingsRow
          title={tx("Pair a phone")}
          description={teamRulesLock?.message ?? description}
          status={
            teamRulesLock ? <TeamRulesLabel>{teamRulesLock.setBy}</TeamRulesLabel> : undefined
          }
          control={
            <TeamRulesInert lock={teamRulesLock}>
              <Button
                size="sm"
                variant="outline"
                disabled={!canPair}
                onClick={() => changeOpen(true)}
              >
                {tx("Pair a phone")}
              </Button>
            </TeamRulesInert>
          }
        />
      )}
      <PhoneSetupDialog
        open={open && teamRulesLock === null}
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
        onTurnOnNetworkAccess={onTurnOnNetworkAccess}
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
      <SettingsSearchTarget id={searchableSetting(PAIR_PHONE_SETTING).id}>
        {content}
      </SettingsSearchTarget>
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
